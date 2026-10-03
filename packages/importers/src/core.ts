import { checkAbort, ImportError, sha256, stableId } from "./common";
import { parseCSV, inspectCSV } from "./csv";
import { parseICS } from "./ics";
import type {
  ImportFile,
  ImportKind,
  ImportOptions,
  ImportPreview,
  ImportSource,
  ParsedImport,
} from "./types";
export * from "./types";
export * from "./common";
export * from "./csv";
export * from "./ics";
export * from "./fit";
export * from "./documents";

function kindFor(name: string, type?: string): ImportKind {
  const ext = name.split(".").pop()?.toLowerCase();
  if (ext === "ics") return "ics";
  if (ext === "csv") return "csv";
  if (ext === "fit") return "fit";
  if (ext === "pdf" || type === "application/pdf") return "pdf";
  if (
    ["png", "jpg", "jpeg"].includes(ext ?? "") ||
    ["image/png", "image/jpeg"].includes(type ?? "")
  )
    return "image";
  throw new ImportError(
    "UNSUPPORTED_FORMAT",
    "Obsługiwane pliki: ICS, CSV, FIT, PDF, JPG i PNG.",
  );
}
export async function previewImport(
  file: File | ImportFile,
  options: ImportOptions = {},
): Promise<ImportPreview> {
  checkAbort(options.signal);
  const max = options.maxBytes ?? 10 * 1024 * 1024;
  if ("size" in file && file.size > max)
    throw new ImportError(
      "FILE_TOO_LARGE",
      "Plik przekracza limit 10 MB. Podziel go na mniejsze pliki.",
    );
  const input = "arrayBuffer" in file ? await file.arrayBuffer() : file.data;
  const data =
    typeof input === "string"
      ? new TextEncoder().encode(input)
      : new Uint8Array(input);
  if (data.byteLength > max)
    throw new ImportError(
      "FILE_TOO_LARGE",
      "Plik przekracza limit 10 MB. Podziel go na mniejsze pliki.",
    );
  if (!data.byteLength)
    throw new ImportError("EMPTY_FILE", "Wybrany plik jest pusty.");
  const kind = kindFor(file.name, file.type);
  const hash = await sha256(data);
  // Calendar identity is stable across file revisions, document identity across renames.
  const source: ImportSource = {
    id:
      options.sourceId ??
      (kind === "ics" || kind === "csv"
        ? `source-${stableId(`${kind}|${file.name}`)}`
        : `source-${hash.slice(0, 24)}`),
    name: file.name,
    type: kind,
    hash,
    parser: `planb-${kind}-1`,
    allowedUse: "local_only",
    importedAt: new Date().toISOString(),
  };
  let parsed: ParsedImport;
  options.onProgress?.({ stage: "Odczyt pliku", progress: 0 });
  if (kind === "ics")
    parsed = parseICS(new TextDecoder().decode(data), source, options);
  else if (kind === "csv")
    parsed = parseCSV(new TextDecoder().decode(data), source, options);
  else if (kind === "fit") {
    const { parseFIT } = await import("./fit");
    parsed = parseFIT(data, source, options);
  } else {
    const { extractDocument } = await import("./documents");
    parsed = await extractDocument(
      data,
      kind === "pdf"
        ? "application/pdf"
        : file.type || (/\.png$/i.test(file.name) ? "image/png" : "image/jpeg"),
      source,
      options,
    );
  }
  checkAbort(options.signal);
  options.onProgress?.({ stage: "Gotowe do sprawdzenia", progress: 1 });
  return {
    id: `batch-${hash.slice(0, 24)}`,
    status: "needs_review",
    source,
    configuration:
      kind === "csv"
        ? {
            timezone: options.timezone,
            delimiter: inspectCSV(
              new TextDecoder().decode(data),
              options.delimiter,
            ).delimiter,
            csvMapping: Object.fromEntries(
              [
                "source",
                "external_id",
                "metric",
                "start",
                "end",
                "timezone",
                "value",
                "unit",
                "version",
              ].map((field) => [
                field,
                options.csvMapping?.[
                  field as keyof NonNullable<ImportOptions["csvMapping"]>
                ] ?? field,
              ]),
            ),
          }
        : kind === "ics"
          ? {
              timezone: options.timezone,
              calendarKind: options.calendarKind ?? "work",
            }
          : {},
    calendar: parsed.calendar ?? [],
    cancellations: parsed.cancellations ?? [],
    calendarSeries: parsed.calendarSeries ?? [],
    observations: parsed.observations ?? [],
    facts: parsed.facts ?? [],
    pages: parsed.pages ?? [],
    attachments:
      kind === "pdf" || kind === "image"
        ? [
            {
              id: `attachment-${hash.slice(0, 24)}`,
              sourceId: source.id,
              name: file.name,
              mimeType:
                kind === "pdf"
                  ? "application/pdf"
                  : file.type ||
                    (/\.png$/i.test(file.name) ? "image/png" : "image/jpeg"),
              data,
            },
          ]
        : [],
    issues: parsed.issues,
    complete: parsed.complete,
    ...(kind === "ics"
      ? {
          horizon: {
            start: options.horizonStart ?? new Date().toISOString(),
            end:
              options.horizonEnd ??
              new Date(Date.now() + 90 * 86_400_000).toISOString(),
          },
        }
      : {}),
  };
}
export interface ConfirmImportOptions {
  confirmedFactIds?: string[];
  rejectedFactIds?: string[];
  primarySourceByMetric?: Record<string, string>;
}
export function confirmImport(
  preview: ImportPreview,
  options: ConfirmImportOptions = {},
): ImportPreview {
  if (preview.status !== "needs_review")
    throw new ImportError(
      "INVALID_IMPORT_STATE",
      "Ta paczka nie oczekuje na zatwierdzenie.",
    );
  if (!preview.complete || preview.issues.some((i) => i.severity === "error"))
    throw new ImportError(
      "INCOMPLETE_IMPORT",
      "Popraw błędy importu przed zatwierdzeniem. Niepełny grafik nie oznacza wolnego czasu.",
    );
  if (preview.issues.some((i) => i.code === "OVERLAPPING_SOURCES")) {
    const affectedMetrics = new Set(
      preview.observations
        .filter((r) =>
          preview.issues.some(
            (i) => i.code === "OVERLAPPING_SOURCES" && i.recordId === r.id,
          ),
        )
        .map((r) => r.metric),
    );
    for (const metric of affectedMetrics)
      if (
        !options.primarySourceByMetric?.[metric] ||
        !preview.observations.some(
          (r) =>
            r.metric === metric &&
            r.sourceName === options.primarySourceByMetric?.[metric],
        )
      )
        throw new ImportError(
          "PRIMARY_SOURCE_REQUIRED",
          `Wybierz źródło nadrzędne dla miary ${metric}.`,
        );
  }
  const confirmed = new Set(options.confirmedFactIds ?? []),
    rejected = new Set(options.rejectedFactIds ?? []);
  for (const id of [...confirmed, ...rejected])
    if (!preview.facts.some((f) => f.id === id))
      throw new ImportError(
        "UNKNOWN_FACT",
        "Wybrane pole nie istnieje w źródle.",
      );
  return {
    ...preview,
    status: "confirmed",
    confirmedAt: new Date().toISOString(),
    facts: preview.facts.map((f) => ({
      ...f,
      status: rejected.has(f.id)
        ? "rejected"
        : confirmed.has(f.id)
          ? "confirmed"
          : f.status,
    })),
    observations: preview.observations.map((o) => ({
      ...o,
      status: "confirmed",
      primary: options.primarySourceByMetric?.[o.metric]
        ? options.primarySourceByMetric[o.metric] === o.sourceName
        : true,
    })),
  };
}
export function cancelImport(preview: ImportPreview): ImportPreview {
  return {
    ...preview,
    status: "cancelled",
    calendar: [],
    cancellations: [],
    calendarSeries: [],
    observations: [],
    facts: [],
    pages: [],
    attachments: [],
  };
}
