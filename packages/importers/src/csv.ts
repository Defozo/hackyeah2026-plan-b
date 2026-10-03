import Papa from "papaparse";
import {
  checkAbort,
  errorIssue,
  ImportError,
  instantFromLocal,
  stableId,
  validTimezone,
} from "./common";
import type {
  CSVField,
  ImportOptions,
  ImportSource,
  ObservationRecord,
  ParsedImport,
} from "./types";

const fields: CSVField[] = [
  "source",
  "external_id",
  "metric",
  "start",
  "end",
  "timezone",
  "value",
  "unit",
  "version",
];
export function inspectCSV(text: string, delimiter?: string) {
  const parsed = Papa.parse<string[]>(text, {
    delimiter,
    preview: 8,
    skipEmptyLines: "greedy",
  });
  return {
    headers: parsed.data[0] ?? [],
    sample: parsed.data.slice(1),
    delimiter: parsed.meta.delimiter,
    errors: parsed.errors,
  };
}
export function parsePolishNumber(value: string): number {
  const cleaned = value.trim().replace(/[\u00a0\u202f ]/g, "");
  if (!/^[+-]?(?:\d+(?:[.,]\d+)?|[.,]\d+)$/.test(cleaned))
    throw new ImportError("INVALID_NUMBER", `Nieprawidłowa liczba: ${value}.`);
  const parsed = Number(cleaned.replace(",", "."));
  if (!Number.isFinite(parsed))
    throw new ImportError(
      "INVALID_NUMBER",
      "Liczba jest poza obsługiwanym zakresem.",
    );
  return parsed;
}
export function normalizeUnit(metric: string, value: number, unit: string) {
  if (!Number.isFinite(value))
    throw new ImportError(
      "INVALID_NUMBER",
      "Liczba jest poza obsługiwanym zakresem.",
    );
  if (
    value < 0 &&
    [
      "steps",
      "sleep",
      "sleep_minutes",
      "activity",
      "activity_minutes",
      "duration",
    ].includes(metric)
  )
    throw new ImportError(
      "INVALID_VALUE",
      "Czas i liczba kroków nie mogą być ujemne.",
    );
  const u = unit.trim().toLowerCase();
  if (
    [
      "sleep",
      "sleep_minutes",
      "activity",
      "activity_minutes",
      "duration",
    ].includes(metric)
  ) {
    if (["h", "hour", "hours", "godz", "godz."].includes(u))
      return { value: value * 60, unit: "min" };
    if (["s", "sec", "seconds"].includes(u))
      return { value: value / 60, unit: "min" };
    if (["min", "minutes", "minuty"].includes(u)) return { value, unit: "min" };
    throw new ImportError(
      "INVALID_UNIT",
      `Miara ${metric} wymaga minut, sekund lub godzin.`,
    );
  }
  if (metric === "steps") {
    if (
      !["steps", "step", "kroki", "count", ""].includes(u) ||
      !Number.isInteger(value)
    )
      throw new ImportError(
        "INVALID_UNIT",
        "Kroki wymagają całkowitej liczby i jednostki steps.",
      );
    return { value, unit: "steps" };
  }
  if (!unit.trim())
    throw new ImportError(
      "MISSING_UNIT",
      "Brakuje jednostki. Nie dopisujemy jej automatycznie.",
    );
  return { value, unit: unit.trim() };
}
export function parseCSV(
  text: string,
  source: ImportSource,
  options: ImportOptions = {},
): ParsedImport {
  const issues: ParsedImport["issues"] = [];
  const observations: ObservationRecord[] = [];
  const rows = Papa.parse<Record<string, string>>(text.replace(/^\uFEFF/, ""), {
    header: true,
    dynamicTyping: false,
    delimiter: options.delimiter,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim(),
  });
  for (const e of rows.errors)
    issues.push({
      code: "CSV_PARSE",
      message: e.message,
      severity: "error",
      row: (e.row ?? 0) + 2,
    });
  if (rows.data.length > (options.maxRows ?? 50_000))
    throw new ImportError(
      "ROW_LIMIT",
      "Plik przekracza limit 50 000 wierszy. Podziel go na mniejsze pliki.",
    );
  const mapping = Object.fromEntries(
    fields.map((f) => [f, options.csvMapping?.[f] ?? f]),
  ) as Record<CSVField, string>;
  for (const field of ["metric", "start", "value", "unit"] as CSVField[])
    if (!rows.meta.fields?.includes(mapping[field]))
      issues.push({
        code: "MISSING_COLUMN",
        message: `Przypisz kolumnę: ${field}.`,
        severity: "error",
      });
  if (issues.length) return { observations, issues, complete: false };
  const seen = new Map<string, ObservationRecord>();
  rows.data.forEach((row, index) => {
    checkAbort(options.signal);
    try {
      const get = (f: CSVField) => String(row[mapping[f]] ?? "").trim();
      const sourceName = get("source") || source.name;
      const timezone = get("timezone") || options.timezone;
      if (timezone && !validTimezone(timezone))
        throw new ImportError(
          "UNKNOWN_TIMEZONE",
          `Nierozpoznana strefa ${timezone}.`,
        );
      const metric = get("metric");
      if (!metric)
        throw new ImportError("MISSING_METRIC", "Brakuje nazwy miary.");
      const start = instantFromLocal(get("start"), timezone);
      const end = get("end") ? instantFromLocal(get("end"), timezone) : start;
      if (Date.parse(end) < Date.parse(start))
        throw new ImportError(
          "INVALID_INTERVAL",
          "Koniec pomiaru poprzedza początek.",
        );
      const numeric = parsePolishNumber(get("value"));
      const normalized = normalizeUnit(metric, numeric, get("unit"));
      const externalId =
        get("external_id") ||
        stableId(
          JSON.stringify([metric, start, end, get("value"), get("unit")]),
        );
      const version = get("version") ? Number(get("version")) : 0;
      if (!Number.isInteger(version) || version < 0)
        throw new ImportError(
          "INVALID_VERSION",
          "Wersja musi być nieujemną liczbą całkowitą.",
        );
      const id = `obs-${stableId(`${source.id}|${sourceName}|${externalId}`)}`;
      const record: ObservationRecord = {
        id,
        sourceId: source.id,
        sourceName,
        externalId,
        version,
        metric,
        start,
        end,
        timezone: timezone || "UTC",
        originalLocal: get("start"),
        ...normalized,
        originalValue: get("value"),
        originalUnit: get("unit"),
        status: "pending",
      };
      const previous = seen.get(id);
      if (previous) {
        if (version > previous.version) seen.set(id, record);
        else if (
          version === previous.version &&
          JSON.stringify(previous) !== JSON.stringify(record)
        )
          issues.push({
            code: "DUPLICATE_CONFLICT",
            message: `Identyfikator ${externalId} ma sprzeczne wartości w tej samej wersji.`,
            severity: "error",
            row: index + 2,
          });
        else
          issues.push({
            code: "DUPLICATE",
            message: `Pominięto powtórzony rekord ${externalId}.`,
            severity: "warning",
            row: index + 2,
          });
      } else seen.set(id, record);
    } catch (error) {
      issues.push(errorIssue(error, index + 2));
    }
  });
  observations.push(...seen.values());
  const byMetric = new Map<string, ObservationRecord[]>();
  for (const record of observations) {
    const group = byMetric.get(record.metric) ?? [];
    group.push(record);
    byMetric.set(record.metric, group);
  }
  for (const group of byMetric.values()) {
    group.sort((a, b) => a.start.localeCompare(b.start));
    let longest: ObservationRecord | undefined,
      other: ObservationRecord | undefined;
    for (const record of group) {
      const previous =
        longest?.sourceName === record.sourceName ? other : longest;
      const overlap =
        previous &&
        (previous.start === previous.end && record.start === record.end
          ? previous.start === record.start
          : previous.start < record.end && record.start < previous.end);
      if (overlap) {
        issues.push({
          code: "OVERLAPPING_SOURCES",
          message: `Miara ${record.metric} pochodzi z nakładających się źródeł ${previous.sourceName} i ${record.sourceName}. Wybierz źródło nadrzędne.`,
          severity: "warning",
          recordId: record.id,
        });
        break;
      }
      if (!longest || record.end > longest.end) {
        if (longest?.sourceName !== record.sourceName) other = longest;
        longest = record;
      } else if (
        record.sourceName !== longest.sourceName &&
        (!other || record.end > other.end)
      )
        other = record;
    }
  }
  return {
    observations,
    issues,
    complete: !issues.some((i) => i.severity === "error"),
  };
}
export function exportCSV(records: ObservationRecord[]): string {
  return Papa.unparse(
    records.map((r) => ({
      source: r.sourceName,
      external_id: r.externalId,
      metric: r.metric,
      start: r.start,
      end: r.end,
      timezone: r.timezone,
      value: r.value,
      unit: r.unit,
      version: r.version,
    })),
    { escapeFormulae: true, newline: "\r\n" },
  );
}
