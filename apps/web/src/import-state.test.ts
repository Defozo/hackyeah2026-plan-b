import { describe, expect, it } from "vitest";
import "fake-indexeddb/auto";
import { createEmptyData, domainDataSchema } from "@planb/domain";
import { previewImport } from "@planb/importers";
import {
  persistImport,
  reviewOverlappingSources,
  resolveObservationConflicts,
  removeImportedSource,
  getImportReplacement,
} from "./import-state";
import { Vault, VaultDb, type AppData } from "./vault";

const empty = (): AppData => ({
  ...createEmptyData(),
  schemaVersion: 1,
  attachments: [],
  importedKeys: [],
  reminders: false,
});

describe("reviewed configuration changes and encrypted packet audit", () => {
  const csvFile = (day = "03", version = 1) => ({
    name: `day-${day}.csv`,
    data: `source,external_id,metric,start,value,alternative,unit,version\nwatch,id-${day},steps,2026-10-${day}T10:00:00,10,20,steps,${version}`,
  });
  const settings = { sourceId: "combined-watch", timezone: "Europe/Warsaw" };
  it("replaces only the remapped packet, acknowledges lost corrections, versions changes and keeps other files", async () => {
    const first = await previewImport(csvFile(), settings);
    let data = persistImport(empty(), first);
    data = persistImport(data, await previewImport(csvFile("04"), settings));
    const originalId = data.observations[0]!.id;
    data.observations[0] = {
      ...data.observations[0]!,
      value: 12,
      revision: 2,
      quality: "Korekta własna; poprzednio 10 steps",
    };
    data.observationImportState!.records[0] = {
      ...data.observationImportState!.records[0]!,
      value: 12,
      version: 2,
    };
    data.exports.push({
      id: "audit-report",
      createdAt: "2026-10-03T10:00:00Z",
      kind: "csv",
      status: "downloaded",
      sourceIds: [settings.sourceId],
    });
    expect(persistImport(data, first)).toBe(data);
    const remapped = await previewImport(csvFile(), {
      ...settings,
      csvMapping: { value: "alternative" },
    });
    expect(getImportReplacement(data, remapped)).toMatchObject({
      legacy: false,
      observations: 1,
      corrections: 1,
    });
    expect(() => persistImport(data, remapped)).toThrow(/Potwierdź wymianę/);
    const corrected = persistImport(data, remapped, {
      replaceReviewedBatch: true,
    });
    expect(corrected.observations).toHaveLength(2);
    expect(
      corrected.observations.find((r) => r.id === originalId),
    ).toMatchObject({ value: 20, revision: 3 });
    expect(
      corrected.observations.find((r) => r.externalId === "id-04")!.value,
    ).toBe(10);
    expect(corrected.sources[0]!.revision).toBe(data.sources[0]!.revision + 1);
    expect(corrected.exports[0]!.status).toBe("stale");
    expect(corrected.importBatches!.filter((b) => b.supersededAt)).toHaveLength(
      1,
    );
    expect(corrected.importBatches!.at(-1)!.replacesBatchIds).toEqual([
      data.importBatches![0]!.id,
    ]);
    const back = persistImport(corrected, first, {
      replaceReviewedBatch: true,
    });
    expect(back.observations.find((r) => r.id === originalId)).toMatchObject({
      value: 10,
      revision: 4,
    });
    const later = persistImport(
      back,
      await previewImport(csvFile("03", 2), settings),
    );
    expect(later.observations.find((r) => r.id === originalId)!.revision).toBe(
      5,
    );
    expect(
      later.observationImportState!.records.find((r) => r.id === originalId)!
        .sourceVersion,
    ).toBe(2);
  });
  it("retains newer overlapping packets when reinterpreting an earlier file", async () => {
    const first = await previewImport(csvFile(), settings);
    let data = persistImport(empty(), first);
    data = persistImport(data, await previewImport(csvFile("03", 2), settings));
    const changed = await previewImport(csvFile(), {
      ...settings,
      csvMapping: { value: "alternative" },
    });
    expect(getImportReplacement(data, changed)!.observations).toBe(0);
    const replaced = persistImport(data, changed, {
      replaceReviewedBatch: true,
    });
    expect(replaced.observations).toHaveLength(1);
    expect(replaced.observations[0]!.value).toBe(10);
    const again = persistImport(replaced, first, {
      replaceReviewedBatch: true,
    });
    expect(again.observations).toHaveLength(1);
    expect(again.observations[0]!.value).toBe(10);
    expect(again.observationImportState!.records[0]!.sourceVersion).toBe(2);
  });
  it("changes calendar purpose and floating-time timezone without duplicating or erasing other packets", async () => {
    const first = await preview(
      event("a", 1, "DTSTART:20261003T100000\nDTEND:20261003T110000"),
    );
    let data = persistImport(empty(), first);
    data = persistImport(data, await preview(event("other", 1, times())));
    const rest = await preview(
      event("a", 1, "DTSTART:20261003T100000\nDTEND:20261003T110000"),
      { calendarKind: "rest", timezone: "UTC" },
    );
    const changed = persistImport(data, rest, { replaceReviewedBatch: true });
    expect(changed.busy).toHaveLength(1);
    expect(changed.protectedWindows).toHaveLength(1);
    expect(changed.protectedWindows[0]!.start).toBe("2026-10-03T10:00:00Z");
    expect(changed.calendarImportState!.records).toHaveLength(2);
    expect(persistImport(changed, rest)).toBe(changed);
  });
  it("requires an explicit full-source reset when an older vault lacks packet provenance", async () => {
    const first = await previewImport(csvFile(), settings);
    const data = persistImport(empty(), first);
    delete data.importBatches;
    data.importedKeys = [`${settings.sourceId}:${first.source.hash}`];
    const changed = await previewImport(csvFile(), {
      ...settings,
      csvMapping: { value: "alternative" },
    });
    expect(getImportReplacement(data, changed)!.legacy).toBe(true);
    expect(() => persistImport(data, changed)).toThrow(/Pełny reset/);
    expect(
      persistImport(data, changed, { replaceReviewedBatch: true })
        .observations[0]!.value,
    ).toBe(20);
  });
  it("encrypts audit configuration and validates it on save; deletion removes the entire private packet trail", async () => {
    const first = await previewImport(
      {
        name: "Jan-Prywatny.csv",
        data: "source,metric,start,patient-secret-column,unit\nwatch,steps,2026-10-03T10:00:00Z,10,steps",
      },
      { csvMapping: { value: "patient-secret-column" } },
    );
    const data = persistImport(empty(), first);
    expect(data.importBatches![0]).toMatchObject({
      status: "confirmed",
      counts: { observations: 1 },
      configuration: { csvMapping: { value: "patient-secret-column" } },
    });
    const vault = new Vault(data.profile.mode);
    vault.db = new VaultDb(`test-batch-audit-${crypto.randomUUID()}`);
    try {
      await vault.create("Synthetic packet audit phrase", data);
      const saved = JSON.stringify(await vault.db.records.toArray());
      expect(saved).not.toContain("patient-secret-column");
      expect(saved).not.toContain("Jan-Prywatny");
      vault.lock();
      const restored = await vault.unlock("Synthetic packet audit phrase");
      expect(restored.importBatches).toEqual(data.importBatches);
      const bad = structuredClone(restored);
      bad.importBatches![0]!.configuration.timezone = "Unregistered/Zone";
      await expect(vault.save(bad)).rejects.toThrow(/Nieobsługiwana/);
      const removed = removeImportedSource(restored, first.source.id);
      expect(removed.importBatches).toEqual([]);
      expect(JSON.stringify(removed)).not.toMatch(
        /patient-secret-column|Jan-Prywatny/,
      );
      await vault.save(removed);
    } finally {
      await vault.db.delete();
    }
  });
});
const options = {
  sourceId: "test-calendar",
  timezone: "Europe/Warsaw",
  horizonStart: "2026-10-01T00:00:00Z",
  horizonEnd: "2026-11-01T00:00:00Z",
};
const event = (uid: string, sequence: number, body: string) =>
  `BEGIN:VEVENT\nUID:${uid}\nSEQUENCE:${sequence}\n${body}\nEND:VEVENT`;
const preview = (events: string, more = {}) =>
  previewImport(
    {
      name: "synthetic.ics",
      data: `BEGIN:VCALENDAR\nVERSION:2.0\n${events}\nEND:VCALENDAR`,
    },
    { ...options, ...more },
  );
const times = (hour = "100000") =>
  `DTSTART:20261003T${hour}Z\nDTEND:20261003T120000Z`;

describe("reviewed import persistence", () => {
  it("persists explicit custom VTIMEZONE rules as resolved UTC while preserving the original timezone and local time", async () => {
    const zone =
      "BEGIN:VTIMEZONE\nTZID:Custom/Synthetic\nBEGIN:STANDARD\nDTSTART:19700101T000000\nTZOFFSETFROM:+0230\nTZOFFSETTO:+0230\nEND:STANDARD\nEND:VTIMEZONE";
    const imported = persistImport(
      empty(),
      await preview(
        zone +
          "\n" +
          event(
            "custom-zone",
            1,
            "DTSTART;TZID=Custom/Synthetic:20261003T100000\nDTEND;TZID=Custom/Synthetic:20261003T110000",
          ),
      ),
    );
    expect(imported.busy[0]!.start).toBe("2026-10-03T07:30:00.000Z");
    expect(imported.busy[0]!.timezone).toBe("UTC");
    expect(imported.busy[0]!.originalLocalStart).toBe("2026-10-03T10:00:00");
    expect(imported.calendarImportState!.records[0]!.originalTimezone).toBe(
      "Custom/Synthetic",
    );
    expect(domainDataSchema.safeParse(imported).success).toBe(true);
    const vault = new Vault(imported.profile.mode);
    vault.db = new VaultDb(`test-custom-timezone-${crypto.randomUUID()}`);
    try {
      await vault.create("Synthetic timezone test phrase", imported);
      vault.lock();
      const restored = await vault.unlock("Synthetic timezone test phrase");
      expect(restored.busy[0]!.start).toBe("2026-10-03T07:30:00.000Z");
      expect(restored.calendarImportState!.records[0]!.originalTimezone).toBe(
        "Custom/Synthetic",
      );
    } finally {
      await vault.db.delete();
    }
  });
  it("preserves existing correction provenance when an unrelated source is imported", async () => {
    const data = empty();
    data.sources.push({
      id: "manual-source",
      kind: "manual",
      name: "Własny wpis",
      createdAt: "2026-10-03T10:00:00Z",
      status: "active",
      revision: 2,
      aiAllowed: false,
      usageVerified: false,
    });
    data.observations.push({
      id: "corrected-observation",
      sourceId: "manual-source",
      metric: "energy",
      start: "2026-10-03T10:00:00Z",
      end: "2026-10-03T10:00:00Z",
      value: 2.5,
      unit: "score",
      status: "confirmed",
      revision: 2,
      quality: "Korekta własna; poprzednio 0 score",
      supersedesId: "earlier-observation",
    });
    const imported = persistImport(data, await preview(event("a", 1, times())));
    expect(imported.observations[0]!.quality).toBe(
      "Korekta własna; poprzednio 0 score",
    );
    expect(imported.observations[0]!.supersedesId).toBe("earlier-observation");
  });
  it("retains unrelated source events on a detached cancellation and ignores stale resurrection", async () => {
    const initial = persistImport(
      empty(),
      await preview(event("a", 1, times()) + "\n" + event("b", 1, times())),
    );
    const cancelled = persistImport(
      initial,
      await preview(event("a", 3, "STATUS:CANCELLED")),
    );
    expect(cancelled.busy).toHaveLength(1);
    expect(cancelled.calendarImportState!.records[0]!.uid).toBe("b");
    const stale = persistImport(
      cancelled,
      await preview(event("a", 2, times("110000"))),
    );
    expect(stale.busy).toHaveLength(1);
    expect(stale.calendarImportState!.cancellations).toHaveLength(1);
    const restored = persistImport(
      stale,
      await preview(event("a", 4, times("110000"))),
    );
    expect(restored.busy).toHaveLength(2);
  });
  it("does not overwrite a newer sequence or mutate the prior version", async () => {
    const initial = persistImport(
      empty(),
      await preview(event("a", 5, times("110000"))),
    );
    const stale = persistImport(initial, await preview(event("a", 2, times())));
    expect(stale.busy[0]!.start).toBe("2026-10-03T11:00:00Z");
    expect(initial.importedKeys).toHaveLength(1);
  });
  it("removes a superseded excluded occurrence only for that series and its horizon", async () => {
    const body =
      "DTSTART:20261003T100000Z\nDTEND:20261003T110000Z\nRRULE:FREQ=DAILY;COUNT=3";
    const initial = persistImport(
      empty(),
      await preview(event("a", 1, body) + "\n" + event("b", 1, times())),
    );
    const updated = persistImport(
      initial,
      await preview(event("a", 2, body + "\nEXDATE:20261004T100000Z")),
    );
    expect(updated.busy).toHaveLength(3);
    expect(
      updated.calendarImportState!.records.filter((r) => r.uid === "b"),
    ).toHaveLength(1);
    expect(
      updated.calendarImportState!.records.filter((r) => r.uid === "a"),
    ).toHaveLength(2);
  });
  it("retains manual protected windows without a kind property and idempotently repeats a batch", async () => {
    const data = empty();
    data.protectedWindows.push({
      id: "manual-rest",
      start: "2026-10-03T00:00:00Z",
      end: "2026-10-03T08:00:00Z",
    });
    const batch = await preview(event("a", 1, times()));
    const imported = persistImport(data, batch);
    expect(imported.protectedWindows).toEqual(data.protectedWindows);
    expect(imported.busy).toHaveLength(1);
    expect(persistImport(imported, batch)).toBe(imported);
  });
  it("allows the same calendar file to extend its import horizon", async () => {
    const body = event(
      "a",
      1,
      "DTSTART:20261003T100000Z\nDTEND:20261003T110000Z\nRRULE:FREQ=DAILY;COUNT=3",
    );
    const initial = persistImport(
      empty(),
      await preview(body, { horizonEnd: "2026-10-04T00:00:00Z" }),
    );
    expect(initial.busy).toHaveLength(1);
    const extended = persistImport(initial, await preview(body));
    expect(extended.busy).toHaveLength(3);
  });
  it("does not resurrect an excluded occurrence from a stale master with a different horizon", async () => {
    const body =
      "DTSTART:20261003T100000Z\nDTEND:20261003T110000Z\nRRULE:FREQ=DAILY;COUNT=3";
    const initial = persistImport(empty(), await preview(event("a", 1, body)));
    const newer = persistImport(
      initial,
      await preview(event("a", 2, body + "\nEXDATE:20261004T100000Z")),
    );
    const stale = persistImport(
      newer,
      await preview(event("a", 1, body), {
        horizonEnd: "2026-11-02T00:00:00Z",
      }),
    );
    expect(stale.busy).toHaveLength(2);
    expect(stale.calendarImportState!.series![0]!.version).toBe(2);
  });
  it("rejects contradictory equal versions without modifying the existing state", async () => {
    const initial = persistImport(
      empty(),
      await preview(event("a", 1, times())),
    );
    const conflict = await preview(event("a", 1, times("110000")));
    expect(() => persistImport(initial, conflict)).toThrow(/Ta sama wersja/);
    expect(initial.busy[0]!.start).toBe("2026-10-03T10:00:00Z");
  });
});

describe("observations across separately imported sources", () => {
  const csv = (
    source: string,
    value = 10,
    day = "03",
    version = 1,
    name = `${source}.csv`,
  ) =>
    previewImport({
      name,
      data: `source,external_id,metric,start,end,value,unit,version\n${source},sample-${day},steps,2026-10-${day}T10:00:00Z,2026-10-${day}T11:00:00Z,${value},steps,${version}`,
    });
  it("requires review across files, persists alternatives and keeps nonoverlapping days", async () => {
    const initial = persistImport(empty(), await csv("watch"));
    const phone = await csv("phone", 12);
    const review = reviewOverlappingSources(initial, phone);
    expect(review.sourceConflicts).toHaveLength(1);
    expect(() => persistImport(initial, phone)).toThrow(/źródło nadrzędne/);
    const conflict = review.sourceConflicts[0]!;
    const selected = conflict.sources.find((s) => s.name === "watch")!.key;
    const imported = persistImport(initial, phone, {
      sourceResolutions: { [conflict.id]: selected },
    });
    expect(imported.observations.map((o) => o.value)).toEqual([10]);
    expect(imported.observationImportState!.records).toHaveLength(2);
    expect(
      reviewOverlappingSources(JSON.parse(JSON.stringify(imported)))
        .sourceConflicts[0]!.selected,
    ).toBe(selected);
    const anotherDay = persistImport(imported, await csv("phone", 20, "04"));
    expect(anotherDay.observations.map((o) => o.value)).toEqual([10, 20]);
    expect(initial.observations).toHaveLength(1);
  });
  it("allows a deliberate later source choice and marks earlier reports stale", async () => {
    const initial = persistImport(empty(), await csv("watch"));
    initial.exports.push({
      id: "report",
      createdAt: "2026-10-03T12:00:00Z",
      kind: "csv",
      status: "downloaded",
      sourceIds: [initial.sources[0]!.id],
    });
    const phone = await csv("phone", 12),
      conflict = reviewOverlappingSources(initial, phone).sourceConflicts[0]!;
    const imported = persistImport(initial, phone, {
      sourceResolutions: {
        [conflict.id]: conflict.sources.find((s) => s.name === "watch")!.key,
      },
    });
    const changed = resolveObservationConflicts(imported, {
      [conflict.id]: conflict.sources.find((s) => s.name === "phone")!.key,
    });
    expect(changed.observations.map((o) => o.value)).toEqual([12]);
    expect(changed.exports[0]!.status).toBe("stale");
  });
  it("deduplicates named-device identifiers across filenames and refuses equal-version contradictions", async () => {
    const initial = persistImport(empty(), await csv("watch"));
    const renamed = persistImport(
      initial,
      await csv("watch", 10, "03", 1, "renamed.csv"),
    );
    expect(renamed.observations).toHaveLength(1);
    const contradictory = await csv("watch", 11, "03", 1, "renamed.csv");
    expect(() => persistImport(initial, contradictory)).toThrow(
      /tej samej wersji/,
    );
    const newer = persistImport(initial, await csv("watch", 11, "03", 2));
    expect(newer.observations.map((o) => o.value)).toEqual([11]);
  });
  it("does not promote a discarded source automatically when its chosen counterpart is deleted", async () => {
    const initial = persistImport(empty(), await csv("watch"));
    const phone = await csv("phone", 12),
      conflict = reviewOverlappingSources(initial, phone).sourceConflicts[0]!;
    const imported = persistImport(initial, phone, {
      sourceResolutions: {
        [conflict.id]: conflict.sources.find((s) => s.name === "watch")!.key,
      },
    });
    const deleted = removeImportedSource(imported, initial.sources[0]!.id);
    expect(deleted.observations).toHaveLength(0);
    expect(
      deleted.observationImportState!.records.map((r) => r.sourceName),
    ).toEqual(["phone"]);
    const remaining = reviewOverlappingSources(deleted).sourceConflicts[0]!;
    expect(remaining.selected).toBeUndefined();
    const restored = resolveObservationConflicts(deleted, {
      [remaining.id]: remaining.sources[0]!.key,
    });
    expect(restored.observations.map((o) => o.value)).toEqual([12]);
  });
  it("compares instants with offsets and does not conflict at exclusive range boundaries", async () => {
    const initial = persistImport(empty(), await csv("watch"));
    const row = await csv("phone");
    row.observations[0]!.start = "2026-10-03T12:00:00+02:00";
    row.observations[0]!.end = "2026-10-03T13:00:00+02:00";
    expect(reviewOverlappingSources(initial, row).sourceConflicts).toHaveLength(
      1,
    );
    row.observations[0]!.start = "2026-10-03T11:00:00Z";
    row.observations[0]!.end = "2026-10-03T12:00:00Z";
    expect(reviewOverlappingSources(initial, row).sourceConflicts).toHaveLength(
      0,
    );
  });
});

describe("document originals and source deletion", () => {
  it("persists page evidence and pending status, then removes every private derivative and import key", async () => {
    const batch = await preview("");
    batch.source.type = "pdf";
    batch.source.name = "synthetic-document.pdf";
    batch.pages = [
      {
        sourceId: batch.source.id,
        page: 1,
        text: "Prywatny fragment: 20 min",
        extraction: "text",
        image: new Uint8Array([1, 2, 3]),
        imageType: "image/png",
      },
    ];
    batch.facts = [
      {
        id: "fact-1",
        sourceId: batch.source.id,
        page: 1,
        label: "Prywatny fragment",
        text: "Prywatny fragment: 20 min",
        originalText: "Prywatny fragment: 20 min",
        extraction: "text",
        version: 1,
        unit: "min",
        status: "pending",
      },
    ];
    batch.attachments = [
      {
        id: "original",
        sourceId: batch.source.id,
        name: batch.source.name,
        mimeType: "application/pdf",
        data: new Uint8Array([4, 5, 6]),
      },
    ];
    const imported = persistImport(empty(), batch);
    expect(imported.attachments).toHaveLength(2);
    expect(imported.documentFacts[0]!.status).toBe("pending");
    expect(imported.documentPages![0]!.imageAttachmentId).toBe(
      imported.attachments[1]!.id,
    );
    const removed = removeImportedSource(imported, batch.source.id);
    expect(removed.attachments).toHaveLength(0);
    expect(removed.documentFacts).toHaveLength(0);
    expect(removed.importedKeys).toHaveLength(0);
    expect(JSON.stringify(removed)).not.toContain("Prywatny fragment");
    expect(persistImport(removed, batch).documentFacts).toHaveLength(1);
  });
});
