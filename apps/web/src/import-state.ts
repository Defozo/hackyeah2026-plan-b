import {
  confirmImport,
  stableId,
  validTimezone,
  normalizeUnit,
  parsePolishNumber,
  type ImportPreview,
  type ConfirmImportOptions,
  type ObservationRecord,
} from "@planb/importers";
import {
  correctSource,
  deleteSource,
  type Interval,
  type Observation,
} from "@planb/domain";
import { type AppData, toBase64 } from "./vault";

export interface SourceConflict {
  id: string;
  metric: string;
  start: string;
  end: string;
  recordIds: string[];
  sources: { key: string; name: string; sourceId: string }[];
  selected?: string;
}
export interface PersistImportOptions extends ConfirmImportOptions {
  sourceResolutions?: Record<string, string>;
  replaceReviewedBatch?: boolean;
}
const configurationKey = (p: ImportPreview) =>
  stableId(
    JSON.stringify({
      timezone: p.configuration?.timezone ?? null,
      calendarKind: p.configuration?.calendarKind ?? null,
      delimiter: p.configuration?.delimiter ?? null,
      csvMapping: Object.entries(p.configuration?.csvMapping ?? {}).sort(
        ([a], [b]) => a.localeCompare(b),
      ),
    }),
  );
const cancellationKey = (r: { uid: string; recurrenceId?: string }) =>
  JSON.stringify([r.uid, r.recurrenceId ?? null]);
/** The file hash identifies the packet; configuration and horizon identify its reviewed interpretation. */
export function getImportReplacement(data: AppData, preview: ImportPreview) {
  const sourceId = preview.source.id;
  const sameFile = (data.importBatches ?? []).filter(
    (b) =>
      b.sourceId === sourceId &&
      b.hash === preview.source.hash &&
      !b.supersededAt,
  );
  const legacy =
    !sameFile.length &&
    (data.importedKeys.includes(preview.source.hash) ||
      data.importedKeys.some(
        (k) =>
          k === `${sourceId}:${preview.source.hash}` ||
          k.startsWith(`${sourceId}:${preview.source.hash}:`),
      ));
  if (
    !legacy &&
    (!sameFile.length ||
      sameFile.at(-1)!.configurationKey === configurationKey(preview))
  )
    return null;
  const ids = {
    calendar: new Set<string>(),
    observations: new Set<string>(),
    facts: new Set<string>(),
    cancellations: new Set<string>(),
    series: new Set<string>(),
  };
  if (legacy) {
    [...data.busy, ...data.protectedWindows]
      .filter((r) => r.sourceId === sourceId)
      .forEach((r) => ids.calendar.add(r.id));
    existingRecords(data)
      .filter((r) => r.sourceId === sourceId)
      .forEach((r) => ids.observations.add(r.id));
    data.documentFacts
      .filter((r) => r.sourceId === sourceId)
      .forEach((r) => ids.facts.add(r.id));
    data.calendarImportState?.cancellations
      .filter((r) => r.sourceId === sourceId)
      .forEach((r) => ids.cancellations.add(cancellationKey(r)));
    data.calendarImportState?.series
      ?.filter((r) => r.sourceId === sourceId)
      .forEach((r) => ids.series.add(r.uid));
  } else {
    // A later packet may have updated a shared record. Its data remain authoritative.
    for (const kind of Object.keys(ids) as (keyof typeof ids)[]) {
      const owners = new Map<string, string>();
      for (const batch of data.importBatches ?? [])
        if (batch.sourceId === sourceId && !batch.supersededAt)
          for (const id of batch.recordIds[kind]) owners.set(id, batch.id);
      const replacedBatchIds = new Set(sameFile.map((b) => b.id));
      for (const batch of sameFile)
        for (const id of batch.recordIds[kind]) {
          const owner = owners.get(id);
          if (owner && replacedBatchIds.has(owner)) ids[kind].add(id);
        }
    }
  }
  return {
    legacy,
    ids,
    batchIds: legacy
      ? (data.importBatches ?? [])
          .filter((b) => b.sourceId === sourceId && !b.supersededAt)
          .map((b) => b.id)
      : sameFile.map((b) => b.id),
    observations: ids.observations.size,
    calendar: ids.calendar.size,
    facts: ids.facts.size,
    corrections: data.observations.filter(
      (o) =>
        ids.observations.has(o.id) && Boolean(o.quality?.startsWith("Korekta")),
    ).length,
  };
}
function withoutReplacedRecords(
  data: AppData,
  preview: ImportPreview,
  replacement: NonNullable<ReturnType<typeof getImportReplacement>>,
): AppData {
  const ids = replacement.ids,
    sourceId = preview.source.id;
  return {
    ...data,
    busy: data.busy.filter((r) => !ids.calendar.has(r.id)),
    protectedWindows: data.protectedWindows.filter(
      (r) => !ids.calendar.has(r.id),
    ),
    observations: data.observations.filter((r) => !ids.observations.has(r.id)),
    documentFacts: data.documentFacts.filter((r) => !ids.facts.has(r.id)),
    calendarImportState: data.calendarImportState
      ? {
          records: data.calendarImportState.records.filter(
            (r) => !ids.calendar.has(r.id),
          ),
          cancellations: data.calendarImportState.cancellations.filter(
            (r) =>
              r.sourceId !== sourceId ||
              !ids.cancellations.has(cancellationKey(r)),
          ),
          series: data.calendarImportState.series?.filter(
            (r) => r.sourceId !== sourceId || !ids.series.has(r.uid),
          ),
        }
      : undefined,
    observationImportState: data.observationImportState
      ? {
          records: data.observationImportState.records.filter(
            (r) => !ids.observations.has(r.id),
          ),
          resolutions: data.observationImportState.resolutions.filter(
            (r) => !r.recordIds.some((id) => ids.observations.has(id)),
          ),
        }
      : undefined,
    importedKeys: data.importedKeys.filter((k) =>
      replacement.legacy
        ? !k.startsWith(`${sourceId}:`) && k !== preview.source.hash
        : !k.startsWith(`${sourceId}:${preview.source.hash}:`),
    ),
  };
}
const sourceKey = (r: ObservationRecord) => `${r.sourceId}|${r.sourceName}`;
const overlaps = (a: ObservationRecord, b: ObservationRecord) => {
  const as = Date.parse(a.start),
    ae = Date.parse(a.end),
    bs = Date.parse(b.start),
    be = Date.parse(b.end);
  return as === ae
    ? bs === be
      ? as === bs
      : as >= bs && as < be
    : bs === be
      ? bs >= as && bs < ae
      : as < be && bs < ae;
};
function existingRecords(data: AppData): ObservationRecord[] {
  const imported = data.observationImportState?.records ?? [];
  const ids = new Set(imported.map((r) => r.id));
  return [
    ...imported,
    ...data.observations
      .filter((o) => !ids.has(o.id) && typeof o.value === "number")
      .map((o) => ({
        id: o.id,
        sourceId: o.sourceId,
        sourceName:
          data.sources.find((s) => s.id === o.sourceId)?.name ?? o.sourceId,
        externalId: o.externalId ?? o.id,
        version: o.revision,
        metric: o.metric,
        start: o.start,
        end: o.end,
        timezone: o.timezone ?? data.profile.timezone,
        originalLocal: o.originalLocalStart ?? o.start,
        value: Number(o.value),
        unit: o.unit,
        originalValue: String(o.value),
        originalUnit: o.unit,
        status: o.status,
        primary: true,
      })),
  ];
}
/** Compare against all earlier imports, including inactive alternatives, before any write. */
export function reviewOverlappingSources(
  data: AppData,
  preview?: ImportPreview,
): { records: ObservationRecord[]; sourceConflicts: SourceConflict[] } {
  const replacement = preview && getImportReplacement(data, preview);
  const replacedById = new Map(
    replacement ? existingRecords(data).map((r) => [r.id, r] as const) : [],
  );
  const records = existingRecords(
    replacement ? withoutReplacedRecords(data, preview!, replacement) : data,
  );
  const identity = (r: ObservationRecord) =>
    JSON.stringify([r.sourceName, r.externalId, r.metric]);
  const indexById = new Map(records.map((r, i) => [r.id, i]));
  const indexByIdentity = new Map(records.map((r, i) => [identity(r), i]));
  for (const row of preview?.observations ?? []) {
    const index = indexById.get(row.id) ?? indexByIdentity.get(identity(row));
    if (index === undefined) {
      indexById.set(row.id, records.length);
      indexByIdentity.set(identity(row), records.length);
      const replaced = replacedById.get(row.id);
      records.push({
        ...row,
        sourceVersion: row.sourceVersion ?? row.version,
        version: replaced
          ? Math.max(row.version, replaced.version + 1)
          : row.version,
        status: "confirmed",
      });
    } else {
      const previous = records[index]!;
      const previousVersion = previous.sourceVersion ?? previous.version;
      const incomingVersion = row.sourceVersion ?? row.version;
      if (previousVersion > incomingVersion) continue;
      if (previousVersion === incomingVersion) {
        const original = normalizeUnit(
          previous.metric,
          parsePolishNumber(previous.originalValue),
          previous.originalUnit,
        );
        if (
          original.value !== row.value ||
          original.unit !== row.unit ||
          previous.metric !== row.metric ||
          Date.parse(previous.start) !== Date.parse(row.start) ||
          Date.parse(previous.end) !== Date.parse(row.end)
        )
          throw Error(
            "Identyfikator pomiaru ma inne dane w tej samej wersji. Popraw numer wersji w pliku.",
          );
        continue;
      }
      records[index] = {
        ...row,
        sourceVersion: incomingVersion,
        version: Math.max(row.version, previous.version + 1),
        id: previous.id,
        status: "confirmed",
      };
    }
  }
  const sourceConflicts: SourceConflict[] = [];
  const byMetric = new Map<string, ObservationRecord[]>();
  for (const row of records) {
    const rows = byMetric.get(row.metric) ?? [];
    rows.push(row);
    byMetric.set(row.metric, rows);
  }
  for (const [metric, rows] of byMetric) {
    rows.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    const groups: ObservationRecord[][] = [];
    let group: ObservationRecord[] = [],
      end = -Infinity;
    for (const row of rows) {
      const start = Date.parse(row.start);
      // Equal instant measurements belong together; adjacent ranges do not.
      if (
        group.length &&
        (start < end || (start === end && group.some((r) => overlaps(r, row))))
      )
        group.push(row);
      else {
        if (group.length) groups.push(group);
        group = [row];
      }
      end = Math.max(group.length === 1 ? -Infinity : end, Date.parse(row.end));
    }
    if (group.length) groups.push(group);
    for (const component of groups) {
      const sources = [
        ...new Map(
          component.map((r) => [
            sourceKey(r),
            { key: sourceKey(r), name: r.sourceName, sourceId: r.sourceId },
          ]),
        ).values(),
      ];
      if (sources.length < 2 && !component.every((r) => r.primary === false))
        continue;
      const recordIds = component.map((r) => r.id).sort();
      const id = `overlap-${stableId(JSON.stringify(component.map((r) => [r.id, r.version, r.start, r.end, sourceKey(r)]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))))}`;
      const previous = data.observationImportState?.resolutions.find(
        (r) => r.id === id,
      );
      sourceConflicts.push({
        id,
        metric,
        start: component[0]!.start,
        end: component.reduce(
          (last, r) => (Date.parse(last) >= Date.parse(r.end) ? last : r.end),
          component[0]!.end,
        ),
        recordIds,
        sources,
        selected:
          previous && sources.some((s) => s.key === previous.sourceKey)
            ? previous.sourceKey
            : undefined,
      });
    }
  }
  return { records, sourceConflicts };
}
function resolvedObservations(
  data: AppData,
  review: ReturnType<typeof reviewOverlappingSources>,
  choices: Record<string, string>,
) {
  const records = review.records.map((r) => ({ ...r }));
  const recordById = new Map(records.map((r) => [r.id, r]));
  const resolutions: NonNullable<
    AppData["observationImportState"]
  >["resolutions"] = [];
  for (const conflict of review.sourceConflicts) {
    const selected = choices[conflict.id] || conflict.selected;
    if (!selected || !conflict.sources.some((s) => s.key === selected))
      throw Error(`Wybierz źródło nadrzędne dla miary ${conflict.metric}.`);
    for (const id of conflict.recordIds) {
      const record = recordById.get(id)!;
      record.primary = sourceKey(record) === selected;
    }
    resolutions.push({
      id: conflict.id,
      metric: conflict.metric,
      sourceKey: selected,
      recordIds: conflict.recordIds,
      resolvedAt: new Date().toISOString(),
    });
  }
  const importedIds = new Set(records.map((r) => r.id));
  const existingById = new Map(data.observations.map((r) => [r.id, r]));
  const observations: Observation[] = [
    ...data.observations.filter((o) => !importedIds.has(o.id)),
    ...records
      .filter((r) => r.primary !== false)
      .map((row) => ({
        ...existingById.get(row.id),
        id: row.id,
        sourceId: row.sourceId,
        externalId: row.externalId,
        metric: row.metric,
        value: row.value,
        unit: row.unit,
        start: row.start,
        end: row.end,
        timezone: row.timezone,
        originalLocalStart: row.originalLocal,
        status: row.status,
        revision: row.version,
        quality:
          existingById.get(row.id)?.revision === row.version &&
          existingById.get(row.id)?.value === row.value &&
          existingById.get(row.id)?.unit === row.unit
            ? existingById.get(row.id)?.quality
            : row.originalUnit !== row.unit
              ? `Jednostka źródłowa: ${row.originalValue} ${row.originalUnit}`
              : undefined,
      })),
  ];
  return { observations, observationImportState: { records, resolutions } };
}
export function resolveObservationConflicts(
  data: AppData,
  choices: Record<string, string>,
): AppData {
  const review = reviewOverlappingSources(data);
  let next = data;
  for (const sourceId of new Set(
    review.sourceConflicts.flatMap((c) => c.sources.map((s) => s.sourceId)),
  ))
    next = correctSource(next, sourceId, new Date().toISOString());
  return {
    ...next,
    ...resolvedObservations(data, review, choices),
    revision: next.revision + 1,
  };
}

export function removeImportedSource(data: AppData, sourceId: string): AppData {
  const next = deleteSource(data, sourceId, new Date().toISOString());
  const removedIds = new Set(
    data.documentFacts.filter((f) => f.sourceId === sourceId).map((f) => f.id),
  );
  const recordIds = new Set(
    data.observationImportState?.records
      .filter((r) => r.sourceId === sourceId)
      .map((r) => r.id),
  );
  return {
    ...next,
    importBatches: next.importBatches?.filter((b) => b.sourceId !== sourceId),
    attachments: next.attachments.filter((a) => a.sourceId !== sourceId),
    importedKeys: next.importedKeys.filter(
      (k) =>
        !k.startsWith(`${sourceId}:`) &&
        k !== data.sources.find((s) => s.id === sourceId)?.hash,
    ),
    calendarImportState: next.calendarImportState
      ? {
          records: next.calendarImportState.records.filter(
            (r) => r.sourceId !== sourceId,
          ),
          cancellations: next.calendarImportState.cancellations.filter(
            (r) => r.sourceId !== sourceId,
          ),
          series: next.calendarImportState.series?.filter(
            (r) => r.sourceId !== sourceId,
          ),
        }
      : undefined,
    observationImportState: next.observationImportState
      ? {
          records: next.observationImportState.records.filter(
            (r) => r.sourceId !== sourceId,
          ),
          resolutions: next.observationImportState.resolutions.filter(
            (r) => !r.recordIds.some((id) => recordIds.has(id)),
          ),
        }
      : undefined,
    documentPages: next.documentPages?.filter((p) => p.sourceId !== sourceId),
    documentFactMetadata: next.documentFactMetadata?.filter(
      (f) => !removedIds.has(f.id),
    ),
  };
}

/** Caller persists the entire returned state once in the vault transaction. */
export function persistImport(
  data: AppData,
  preview: ImportPreview,
  options: PersistImportOptions = {},
): AppData {
  // The aggregate review below replaces the single-file overlap review.
  const batch = confirmImport(
    {
      ...preview,
      issues: preview.issues.filter((i) => i.code !== "OVERLAPPING_SOURCES"),
    },
    { ...options, primarySourceByMetric: undefined },
  );
  const sourceId = batch.source.id;
  const configKey = configurationKey(batch);
  const key =
    batch.source.type === "ics"
      ? `${sourceId}:${batch.source.hash}:${configKey}:${batch.horizon?.start}:${batch.horizon?.end}`
      : `${sourceId}:${batch.source.hash}:${configKey}`;
  if (data.importedKeys.includes(key)) return data;
  const replacement = getImportReplacement(data, batch);
  if (replacement && !options.replaceReviewedBatch)
    throw Error(
      replacement.legacy
        ? "Starszy zapis nie zawiera zakresu paczki. Pełny reset źródła wymaga jawnego potwierdzenia w podglądzie."
        : "Zmiana konfiguracji zastąpi poprzednie rekordy tej paczki i ich korekty. Potwierdź wymianę w podglądzie.",
    );
  const originalData = data;
  const review = reviewOverlappingSources(data, batch);
  if (replacement)
    data = withoutReplacedRecords(
      correctSource(data, sourceId, batch.confirmedAt!),
      batch,
      replacement,
    );
  let records = [...(data.calendarImportState?.records ?? [])];
  let cancellations = [...(data.calendarImportState?.cancellations ?? [])];
  let seriesVersions = [...(data.calendarImportState?.series ?? [])];
  const intervals = new Map<string, Interval>(
    [...data.busy, ...data.protectedWindows].map((row) => [row.id, row]),
  );
  const protectedIds = new Set(data.protectedWindows.map((row) => row.id));
  let changed = Boolean(replacement);
  const remove = (id: string) => {
    if (intervals.delete(id)) changed = true;
    records = records.filter((r) => r.id !== id);
  };
  for (const cancellation of batch.cancellations) {
    const previous = cancellations.find(
      (c) =>
        c.sourceId === sourceId &&
        c.uid === cancellation.uid &&
        c.recurrenceId === cancellation.recurrenceId,
    );
    if (previous && previous.version > cancellation.version) continue;
    for (const row of [...records])
      if (
        row.sourceId === sourceId &&
        row.uid === cancellation.uid &&
        (!cancellation.recurrenceId ||
          row.recurrenceId === cancellation.recurrenceId) &&
        row.version <= cancellation.version
      )
        remove(row.id);
    cancellations = [
      ...cancellations.filter(
        (c) =>
          !(
            c.sourceId === sourceId &&
            c.uid === cancellation.uid &&
            c.recurrenceId === cancellation.recurrenceId
          ),
      ),
      cancellation,
    ];
  }
  // A present master replaces occurrences of that UID only within its horizon.
  // Detached cancellation/update never erases unrelated source events.
  for (const series of batch.calendarSeries ?? []) {
    const previousVersion =
      seriesVersions.find(
        (s) => s.sourceId === sourceId && s.uid === series.uid,
      )?.version ?? -1;
    if (previousVersion > series.version) continue;
    seriesVersions = [
      ...seriesVersions.filter(
        (s) => !(s.sourceId === sourceId && s.uid === series.uid),
      ),
      series,
    ];
    for (const row of [...records]) {
      const interval = intervals.get(row.id);
      if (
        row.sourceId !== sourceId ||
        row.uid !== series.uid ||
        row.version > series.version ||
        batch.calendar.some((c) => c.id === row.id) ||
        !interval ||
        !batch.horizon
      )
        continue;
      if (
        Date.parse(interval.end) > Date.parse(batch.horizon.start) &&
        Date.parse(interval.start) < Date.parse(batch.horizon.end)
      )
        remove(row.id);
    }
  }
  const intervalTimezones = new Map<string, string>();
  for (const row of batch.calendar) {
    if (
      seriesVersions.some(
        (s) =>
          s.sourceId === sourceId &&
          s.uid === row.uid &&
          s.version > row.version,
      )
    )
      continue;
    if (
      cancellations.some(
        (c) =>
          c.sourceId === sourceId &&
          c.uid === row.uid &&
          (!c.recurrenceId || c.recurrenceId === row.recurrenceId) &&
          c.version >= row.version,
      )
    )
      continue;
    const old = records.find((r) => r.id === row.id);
    if (old && old.version > row.version) continue;
    const previous = intervals.get(row.id);
    if (!intervalTimezones.has(row.timezone))
      intervalTimezones.set(
        row.timezone,
        validTimezone(row.timezone) ? row.timezone : "UTC",
      );
    const next: Interval = {
      id: row.id,
      sourceId,
      start: row.start,
      end: row.end,
      // An explicit VTIMEZONE may use a non-IANA TZID. Parsing already applied
      // its rules to these UTC instants; retain its name in the source ledger.
      timezone: intervalTimezones.get(row.timezone)!,
      originalLocalStart: row.originalLocal,
      originalLocalEnd: row.originalEndLocal,
      kind: row.kind === "busy" ? "work" : row.kind,
      label: row.label,
    };
    if (
      old &&
      old.version === row.version &&
      previous &&
      (previous.start !== next.start || previous.end !== next.end)
    )
      throw Error(
        "Ta sama wersja zdarzenia ma inne godziny. Wyeksportuj zaktualizowany kalendarz z wyższym SEQUENCE.",
      );
    if (JSON.stringify(previous) !== JSON.stringify(next)) changed = true;
    intervals.set(row.id, next);
    if (row.kind === "rest") protectedIds.add(row.id);
    else protectedIds.delete(row.id);
    records = [
      ...records.filter((r) => r.id !== row.id),
      {
        id: row.id,
        sourceId,
        uid: row.uid,
        recurrenceId: row.recurrenceId,
        version: row.version,
        originalTimezone: row.timezone,
      },
    ];
  }
  const choices = { ...options.sourceResolutions };
  for (const conflict of review.sourceConflicts)
    if (
      !choices[conflict.id] &&
      options.primarySourceByMetric?.[conflict.metric]
    )
      choices[conflict.id] =
        conflict.sources.find(
          (s) => s.name === options.primarySourceByMetric![conflict.metric],
        )?.key ?? "";
  const observationState = resolvedObservations(data, review, choices);
  if (
    JSON.stringify(observationState.observations) !==
    JSON.stringify(data.observations)
  )
    changed = true;
  const documents =
    batch.source.type === "pdf" || batch.source.type === "image";
  if (documents) changed = true;
  const oldSource = originalData.sources.find((s) => s.id === sourceId);
  let next = data;
  const activeById = new Map(
    observationState.observations.map((o) => [o.id, o]),
  );
  const affectedSourceIds = new Set(
    data.observations
      .filter((o) => JSON.stringify(activeById.get(o.id)) !== JSON.stringify(o))
      .map((o) => o.sourceId),
  );
  if (oldSource && oldSource.status !== "deleted" && changed)
    affectedSourceIds.add(sourceId);
  for (const affected of affectedSourceIds)
    if (
      !(replacement && affected === sourceId) &&
      data.sources.some((s) => s.id === affected && s.status !== "deleted")
    )
      next = correctSource(next, affected, new Date().toISOString());
  const resultingIntervals = [...intervals.values()];
  const source = {
    id: sourceId,
    kind: batch.source.type,
    name: batch.source.name,
    hash: batch.source.hash,
    parserVersion: batch.source.parser,
    createdAt: oldSource?.createdAt ?? batch.source.importedAt,
    status: "active" as const,
    revision: (oldSource?.revision ?? 0) + (changed || !oldSource ? 1 : 0),
    aiAllowed: false,
    usageVerified: false,
    synthetic: data.profile.mode === "demo",
  };
  const ranges = [...batch.calendar, ...batch.observations];
  const range =
    batch.horizon ??
    (ranges.length
      ? {
          start: ranges.reduce(
            (s, r) => (Date.parse(r.start) < Date.parse(s) ? r.start : s),
            ranges[0]!.start,
          ),
          end: ranges.reduce(
            (e, r) => (Date.parse(r.end) > Date.parse(e) ? r.end : e),
            ranges[0]!.end,
          ),
        }
      : undefined);
  const savedCalendar = new Map(records.map((r) => [r.id, r]));
  const savedObservations = new Map(
    review.records.map((r) => [
      JSON.stringify([r.sourceId, r.sourceName, r.externalId, r.metric]),
      r,
    ]),
  );
  const savedCancellations = new Map(
    cancellations
      .filter((r) => r.sourceId === sourceId)
      .map((r) => [cancellationKey(r), r.version]),
  );
  const savedSeries = new Map(
    seriesVersions
      .filter((r) => r.sourceId === sourceId)
      .map((r) => [r.uid, r.version]),
  );
  const confirmedBatch: NonNullable<AppData["importBatches"]>[number] = {
    id: crypto.randomUUID(),
    sourceId,
    hash: batch.source.hash,
    parserVersion: batch.source.parser,
    status: "confirmed",
    allowedUse: "local_only",
    configuration: batch.configuration ?? {},
    configurationKey: configKey,
    confirmedAt: batch.confirmedAt!,
    range,
    counts: {
      calendar: batch.calendar.length,
      cancellations: batch.cancellations.length,
      observations: batch.observations.length,
      facts: batch.facts.length,
      pages: batch.pages.length,
    },
    recordIds: {
      calendar: batch.calendar
        .filter(
          (r) =>
            savedCalendar.get(r.id)?.version === r.version &&
            intervals.get(r.id)?.start === r.start &&
            intervals.get(r.id)?.end === r.end,
        )
        .map((r) => r.id),
      observations: batch.observations.flatMap((r) => {
        const stored = savedObservations.get(
          JSON.stringify([sourceId, r.sourceName, r.externalId, r.metric]),
        );
        return stored &&
          (stored.sourceVersion ?? stored.version) ===
            (r.sourceVersion ?? r.version)
          ? [stored.id]
          : [];
      }),
      facts: batch.facts.map((r) => r.id),
      cancellations: batch.cancellations
        .filter((r) => savedCancellations.get(cancellationKey(r)) === r.version)
        .map(cancellationKey),
      series: batch.calendarSeries
        .filter((r) => savedSeries.get(r.uid) === r.version)
        .map((r) => r.uid),
    },
    sourceRevision: source.revision,
    replacesBatchIds: replacement?.batchIds ?? [],
  };
  return {
    ...next,
    revision: next.revision + 1,
    importedKeys: [...next.importedKeys, key],
    importBatches: [
      ...(next.importBatches ?? []).map((b) =>
        replacement?.batchIds.includes(b.id)
          ? { ...b, supersededAt: batch.confirmedAt }
          : b,
      ),
      confirmedBatch,
    ],
    sources: [...next.sources.filter((s) => s.id !== sourceId), source],
    calendarImportState: { records, cancellations, series: seriesVersions },
    busy: resultingIntervals.filter((r) => !protectedIds.has(r.id)),
    protectedWindows: resultingIntervals.filter((r) => protectedIds.has(r.id)),
    ...observationState,
    documentFacts: documents
      ? [
          ...next.documentFacts.filter((f) => f.sourceId !== sourceId),
          ...batch.facts.map((f) => ({
            id: f.id,
            sourceId,
            page: f.page,
            label: f.label,
            value: f.text,
            unit: f.unit,
            status: f.status,
            revision: f.version,
            correctedFrom:
              f.text !== f.originalText ? f.originalText : undefined,
          })),
        ]
      : next.documentFacts,
    attachments: documents
      ? [
          ...next.attachments.filter((a) => a.sourceId !== sourceId),
          ...batch.attachments.map((a) => ({
            id: a.id,
            sourceId,
            name: a.name,
            mimeType: a.mimeType,
            base64: toBase64(a.data),
          })),
          ...batch.pages
            .filter((p) => p.image)
            .map((p) => ({
              id: `${sourceId}-page-${p.page}`,
              sourceId,
              name: `Strona ${p.page}`,
              mimeType: p.imageType ?? "image/png",
              base64: toBase64(p.image!),
            })),
        ]
      : next.attachments,
    documentPages: documents
      ? [
          ...(next.documentPages ?? []).filter((p) => p.sourceId !== sourceId),
          ...batch.pages.map((p) => ({
            sourceId,
            page: p.page,
            text: p.text,
            extraction: p.extraction,
            confidence: p.confidence,
            imageAttachmentId: p.image
              ? `${sourceId}-page-${p.page}`
              : undefined,
          })),
        ]
      : next.documentPages,
    documentFactMetadata: documents
      ? [
          ...(next.documentFactMetadata ?? []).filter(
            (f) =>
              !next.documentFacts.some(
                (d) => d.sourceId === sourceId && d.id === f.id,
              ),
          ),
          ...batch.facts.map((f) => ({
            id: f.id,
            originalText: f.originalText,
            extraction: f.extraction,
            confidence: f.confidence,
            referenceRange: f.referenceRange,
            date: f.date,
            numericValue: f.value,
          })),
        ]
      : next.documentFactMetadata,
  };
}
