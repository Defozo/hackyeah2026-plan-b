import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Encoder, Profile } from "@garmin/fitsdk";
import {
  cancelImport,
  confirmImport,
  exportCSV,
  exportICS,
  factsFromPage,
  parseCSV,
  parseFIT,
  parseICS,
  previewImport,
  reviewFact,
  normalizeUnit,
} from "./core";
import type { ImportSource } from "./types";

const source: ImportSource = {
  id: "synthetic-source",
  name: "synthetic",
  type: "ics",
  hash: "synthetic",
  parser: "test",
  allowedUse: "local_only",
  importedAt: "2026-10-03T00:00:00Z",
};

describe("shared manual and imported measurement validation", () => {
  it("rejects negative or fractional counts, negative durations and incompatible units", () => {
    expect(() => normalizeUnit("steps", -1, "steps")).toThrow(/ujemne/);
    expect(() => normalizeUnit("steps", 1.5, "steps")).toThrow(/całkowitej/);
    expect(() => normalizeUnit("sleep", 8, "kg")).toThrow(/minut/);
    expect(() => normalizeUnit("sleep", -8, "h")).toThrow(/ujemne/);
    expect(() => normalizeUnit("energy", NaN, "score")).toThrow(/zakresem/);
    expect(normalizeUnit("steps", 0, "steps")).toEqual({
      value: 0,
      unit: "steps",
    });
    expect(normalizeUnit("sleep", 7.5, "h")).toEqual({
      value: 450,
      unit: "min",
    });
  });
});
const options = {
  timezone: "Europe/Warsaw",
  horizonStart: "2026-10-01T00:00:00Z",
  horizonEnd: "2026-11-01T00:00:00Z",
};
const ics = (body: string) =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${body}\r\nEND:VCALENDAR`;
const event = (body: string) =>
  `BEGIN:VEVENT\r\nUID:synthetic\r\n${body}\r\nEND:VEVENT`;

describe("ICS actual ical.js integration", () => {
  it("expands a night series across DST, applies moved exception, exclusion and cancellation and strips private fields", () => {
    const result = parseICS(
      readFileSync("fixtures/imports/shifts-dst.ics", "utf8"),
      source,
      options,
    );
    expect(result.issues).toEqual([]);
    expect(result.calendar).toHaveLength(4);
    const shifted = result.calendar!.find(
      (r) => r.recurrenceId === "2026-10-24T22:00:00",
    );
    expect(shifted?.start).toBe("2026-10-24T21:00:00Z");
    expect(shifted?.end).toBe("2026-10-25T06:00:00Z");
    expect(result.cancellations).toEqual([
      {
        uid: "synthetic-night-shift",
        recurrenceId: "2026-10-25T22:00:00",
        version: 3,
        sourceId: source.id,
      },
    ]);
    const allDay = result.calendar!.find((r) => r.allDay);
    expect(allDay?.start).toBe("2026-10-26T23:00:00Z");
    expect(allDay?.end).toBe("2026-10-28T23:00:00Z");
    expect(JSON.stringify(result)).not.toContain("Private description");
    expect(JSON.stringify(result)).not.toContain("example.invalid");
  });
  it("uses IANA DST rules for successive recurring dates", () => {
    const result = parseICS(
      ics(
        event(
          "DTSTART;TZID=Europe/Warsaw:20261024T100000\r\nDTEND;TZID=Europe/Warsaw:20261024T110000\r\nRRULE:FREQ=DAILY;COUNT=3",
        ),
      ),
      source,
      options,
    );
    expect(result.calendar!.map((r) => r.start)).toEqual([
      "2026-10-24T08:00:00Z",
      "2026-10-25T09:00:00Z",
      "2026-10-26T09:00:00Z",
    ]);
  });
  it("uses supplied VTIMEZONE definition for non-IANA identifier", () => {
    const zone =
      "BEGIN:VTIMEZONE\r\nTZID:Custom/Synthetic\r\nBEGIN:STANDARD\r\nDTSTART:19700101T000000\r\nTZOFFSETFROM:+0230\r\nTZOFFSETTO:+0230\r\nEND:STANDARD\r\nEND:VTIMEZONE";
    const result = parseICS(
      ics(
        `${zone}\r\n${event("DTSTART;TZID=Custom/Synthetic:20261003T100000\r\nDTEND;TZID=Custom/Synthetic:20261003T110000")}`,
      ),
      source,
      options,
    );
    expect(result.issues).toEqual([]);
    expect(result.calendar![0]!.start).toBe("2026-10-03T07:30:00.000Z");
  });
  it("does not guess missing, unknown or ambiguous timezone", () => {
    const floating = parseICS(
      ics(event("DTSTART:20261003T100000\r\nDTEND:20261003T110000")),
      source,
      { horizonStart: options.horizonStart, horizonEnd: options.horizonEnd },
    );
    expect(floating.complete).toBe(false);
    expect(floating.issues[0]!.code).toBe("TIMEZONE_REQUIRED");
    const unknown = parseICS(
      ics(
        event(
          "DTSTART;TZID=Unknown/Nowhere:20261003T100000\r\nDTEND;TZID=Unknown/Nowhere:20261003T110000",
        ),
      ),
      source,
      options,
    );
    expect(unknown.complete).toBe(false);
    expect(unknown.calendar).toEqual([]);
    const ambiguous = parseICS(
      ics(
        event(
          "DTSTART;TZID=Europe/Warsaw:20261025T023000\r\nDTEND;TZID=Europe/Warsaw:20261025T033000",
        ),
      ),
      source,
      options,
    );
    expect(ambiguous.complete).toBe(false);
    expect(ambiguous.issues[0]!.code).toBe("AMBIGUOUS_LOCAL_TIME");
  });
  it("picks newest SEQUENCE and treats cancellation as a tombstone", () => {
    const result = parseICS(
      ics(
        `${event("SEQUENCE:1\r\nDTSTART:20261003T100000Z\r\nDTEND:20261003T110000Z")}\r\n${event("SEQUENCE:3\r\nSTATUS:CANCELLED")}`,
      ),
      source,
      options,
    );
    expect(result.complete).toBe(true);
    expect(result.calendar).toHaveLength(0);
    expect(result.cancellations![0]!.version).toBe(3);
  });
  it("marks truncated recurrences incomplete rather than creating apparent free time", () => {
    const result = parseICS(
      ics(
        event(
          "DTSTART:20261003T100000Z\r\nDTEND:20261003T110000Z\r\nRRULE:FREQ=DAILY",
        ),
      ),
      source,
      { ...options, maxOccurrences: 2 },
    );
    expect(result.complete).toBe(false);
    expect(result.issues[0]!.code).toBe("RECURRENCE_LIMIT");
  });
  it("exports stable UID and supplied version; suppresses alarms in protected rest", () => {
    const text = exportICS({
      uid: "plan-1@planb.local",
      sequence: 4,
      start: "2026-10-03T10:00:00Z",
      end: "2026-10-03T10:20:00Z",
      title: "Spacer, mój wybór",
      reminderMinutes: 10,
      quietWindows: [
        { start: "2026-10-03T09:00:00Z", end: "2026-10-03T10:00:00Z" },
      ],
    });
    expect(text).toContain("SEQUENCE:4");
    expect(text).not.toContain("VALARM");
    const parsed = parseICS(text, source, options);
    expect(parsed.calendar![0]!.uid).toBe("plan-1@planb.local");
  });
});

describe("CSV import and explicit review", () => {
  it("normalizes Polish numbers, preserves zero/missing distinction, deduplicates and flags overlapping sources", async () => {
    const result = await previewImport({
      name: "synthetic.csv",
      data: readFileSync("fixtures/imports/observations-pl.csv", "utf8"),
    });
    expect(result.complete).toBe(true);
    expect(result.observations).toHaveLength(3);
    expect(result.observations[0]!.value).toBe(450);
    expect(result.observations[0]!.unit).toBe("min");
    expect(result.observations[0]!.end).toBe("2026-10-25T06:00:00Z");
    expect(() => confirmImport(result)).toThrow(/źródło nadrzędne/);
    const saved = confirmImport(result, {
      primarySourceByMetric: { steps: "synthetic-watch" },
    });
    expect(
      saved.observations.find((o) => o.sourceName === "synthetic-phone")!
        .primary,
    ).toBe(false);
    expect(result.status).toBe("needs_review");
  });
  it("maps custom columns with commas and keeps explicit 0", () => {
    const result = parseCSV(
      "typ;kiedy;wartosc;jednostka\nenergy;2026-10-03T10:00:00Z;0;score",
      source,
      {
        csvMapping: {
          metric: "typ",
          start: "kiedy",
          value: "wartosc",
          unit: "jednostka",
        },
      },
    );
    expect(result.observations![0]!.value).toBe(0);
    const missing = parseCSV(
      "metric,start,value,unit\nenergy,2026-10-03T10:00:00Z,,score",
      source,
    );
    expect(missing.complete).toBe(false);
    expect(missing.observations).toHaveLength(0);
  });
  it("rejects inconsistent unit and neutralizes exported spreadsheet formulas", () => {
    const invalid = parseCSV(
      "metric,start,value,unit\nsleep,2026-10-03T10:00:00Z,4,kg",
      source,
    );
    expect(invalid.complete).toBe(false);
    const valid = parseCSV(
      "source,external_id,metric,start,value,unit\n=1+1,@evil,energy,2026-10-03T10:00:00Z,4,score",
      source,
    );
    expect(exportCSV(valid.observations!)).toContain("'=1+1");
    expect(exportCSV(valid.observations!)).toContain("'@evil");
  });
  it("rejects incomplete input, respects byte limits and abort, and never mutates earlier data", async () => {
    await expect(
      previewImport({ name: "large.csv", data: "1234" }, { maxBytes: 2 }),
    ).rejects.toThrow(/10 MB/);
    const controller = new AbortController();
    controller.abort();
    await expect(
      previewImport(
        { name: "abort.csv", data: "test" },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    const preview = await previewImport({
      name: "broken.csv",
      data: "metric,start,value,unit\nsleep,broken,2,h",
    });
    expect(() => confirmImport(preview)).toThrow(/Popraw błędy/);
    expect(cancelImport(preview).observations).toEqual([]);
    expect(preview.status).toBe("needs_review");
  });
});

describe("FIT official Garmin SDK", () => {
  const sample = () => {
    const encoder = new Encoder();
    const write = (number: number, message: Record<string, unknown>) =>
      encoder.onMesg(number, message as Parameters<Encoder["onMesg"]>[1]);
    write(Profile.MesgNum.FILE_ID, {
      type: "activity",
      manufacturer: "development",
      product: 1,
      timeCreated: new Date("2026-10-03T10:00:00Z"),
    });
    write(Profile.MesgNum.RECORD, {
      timestamp: new Date("2026-10-03T10:00:00Z"),
      positionLat: 1234,
      positionLong: 5678,
      heartRate: 120,
    });
    write(Profile.MesgNum.SESSION, {
      startTime: new Date("2026-10-03T10:00:00Z"),
      timestamp: new Date("2026-10-03T10:30:00Z"),
      totalElapsedTime: 1800,
      totalTimerTime: 1750,
      sport: "walking",
    });
    return encoder.close();
  };
  it("decodes synthetic official-SDK output and projects only time and sport without GPS", () => {
    const result = parseFIT(sample(), { ...source, type: "fit" });
    expect(result.complete).toBe(true);
    expect(result.observations![0]!.activityType).toBe("walking");
    expect(result.observations![0]!.value).toBeCloseTo(1750 / 60);
    expect(JSON.stringify(result)).not.toMatch(
      /positionLat|positionLong|heartRate|1234|5678/,
    );
  });
  it("rejects corrupted FIT CRC", () => {
    const bytes = sample();
    bytes[20] ^= 1;
    expect(() => parseFIT(bytes, source)).toThrow(/CRC/);
  });
});

describe("document evidence and field confirmation", () => {
  it("keeps dates and clock times as literal evidence instead of numbers with invented units", () => {
    const facts = factsFromPage({
      page: 1,
      sourceId: source.id,
      text: "Data: 2026-10-03\nGodzina: 12:30\nCzas: 20 min",
      extraction: "text",
    });
    expect(facts[0]!.value).toBeUndefined();
    expect(facts[0]!.unit).toBeUndefined();
    expect(facts[0]!.date).toBe("2026-10-03");
    expect(facts[1]!.value).toBeUndefined();
    expect(facts[2]!.value).toBe(20);
  });
  it("keeps unrecognizable digits literal and never invents reference ranges", () => {
    const facts = factsFromPage({
      page: 2,
      sourceId: source.id,
      text: "Dane syntetyczne\nWartość: 12,5 mg/L\nNieczytelne: l2,S mg/L",
      extraction: "ocr",
      confidence: 60,
    });
    expect(facts[1]!.value).toBe(12.5);
    expect(facts[1]!.unit).toBe("mg/L");
    expect(facts[1]!.referenceRange).toBeUndefined();
    expect(facts[2]!.value).toBeUndefined();
    expect(facts.every((f) => f.status === "pending")).toBe(true);
    const fixed = reviewFact(
      facts[2]!,
      { value: 12.5, unit: "mg/L" },
      "confirmed",
    );
    expect(fixed.originalText).toBe("Nieczytelne: l2,S mg/L");
    expect(fixed.version).toBe(2);
    expect(facts[2]!.status).toBe("pending");
    expect(
      reviewFact(facts[1]!, { text: "Wartość: nieczytelna" }, "pending").value,
    ).toBeUndefined();
  });
});
