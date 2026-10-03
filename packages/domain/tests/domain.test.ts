import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  acceptRevision,
  buildCarePacket,
  contains,
  correctSource,
  createDemoData,
  createRepairInput,
  deleteSource,
  epoch,
  horizonEnd,
  iso,
  localDate,
  overlaps,
  recordOutcome,
  rejectPreview,
  repairPlan,
  resolveLocalTime,
  subtractIntervals,
  summarizeHistory,
} from "../src";
import type {
  AcceptRevisionRequest,
  ActivityVariant,
  Interval,
  RepairInput,
} from "../src";
import { observationSchema } from "../src";

const now = "2026-10-03T10:00:00Z";
const minutes = (minute: number) => iso(epoch(now) + minute * 60000);
const window = (
  id: string,
  start: number,
  end: number,
  kind: Interval["kind"] = "available",
): Interval => ({ id, start: minutes(start), end: minutes(end), kind });
const variant = (
  id: string,
  duration: number,
  overrides: Partial<ActivityVariant> = {},
): ActivityVariant => ({
  id,
  name: id,
  templateId: "own",
  activityType: "training",
  intentIds: ["intent"],
  durationMinutes: duration,
  preparationMinutes: 0,
  travelMinutes: 0,
  locationId: "home",
  resourceIds: [],
  confirmed: true,
  ...overrides,
});
function input(): RepairInput {
  return {
    now,
    timezone: "Europe/Warsaw",
    intent: { id: "intent", label: "Mój cel" },
    plan: {
      ...window("plan", 10, 60, "activity"),
      variantId: "original",
      intentId: "intent",
      status: "accepted",
      revision: 0,
    },
    activities: [
      {
        id: "own",
        name: "Własne",
        variants: [
          variant("original", 30, { travelMinutes: 20 }),
          variant("short", 15, { preparationMinutes: 5 }),
        ],
      },
    ],
    availability: [window("short-window", 10, 30), window("later", 100, 160)],
    busy: [],
    protectedWindows: [],
    constraints: [],
    resources: [{ id: "home", label: "Dom", status: "available" }],
    priorities: ["time", "duration"],
    inputVersion: 0,
  };
}

describe("repair engine", () => {
  it("repairs the full 50 minute cost inside a 20 minute window without claiming an equivalent dose", () => {
    const result = repairPlan(input());
    expect(
      result.conflicts.some(
        (r) => r.message === "Potrzebujesz 50 minut, masz 20.",
      ),
    ).toBe(true);
    expect(result.candidates[0]).toMatchObject({
      variantId: "short",
      totalMinutes: 20,
      durationMinutes: 15,
    });
    expect(
      result.candidates[0]!.reasons.some(
        (r) =>
          r.code === "DURATION_CHANGED" &&
          r.message.includes("nie jest ta sama dawka"),
      ),
    ).toBe(true);
    expect(
      result.candidates.some(
        (c) => c.variantId === "original" && c.start === minutes(100),
      ),
    ).toBe(true);
    expect(result.alwaysAvailable).toEqual(["rest", "defer"]);
  });
  it("lets the user prioritize length or time with actual minute differences", () => {
    const a = input();
    expect(repairPlan(a).candidates[0]!.variantId).toBe("short");
    a.priorities = ["duration", "time"];
    expect(repairPlan(a).candidates[0]).toMatchObject({
      variantId: "original",
      changes: { startShiftMinutes: 90, durationDeltaMinutes: 0 },
    });
  });
  it("separates changed intentions until permission and labels the resulting change", () => {
    const a = input();
    a.activities[0]!.variants[1]!.intentIds = ["other"];
    expect(repairPlan(a).candidates.every((c) => c.variantId !== "short")).toBe(
      true,
    );
    expect(
      repairPlan(a).rejected.some((c) =>
        c.reasonCodes.includes("INTENT_CHANGED"),
      ),
    ).toBe(true);
    a.allowIntentChange = true;
    expect(
      repairPlan(a).candidates.find((c) => c.variantId === "short"),
    ).toMatchObject({ intentPreserved: false, intentId: "other" });
  });
  it("requires confirmed travel time, asks only useful questions and never treats unknown as zero", () => {
    const a = input();
    a.activities[0]!.variants[1]!.travelMinutes = null;
    expect(repairPlan(a).candidates.some((c) => c.variantId === "short")).toBe(
      false,
    );
    expect(
      repairPlan(a).conditional.some((c) =>
        c.reasonCodes.includes("MISSING_TRAVEL_TIME"),
      ),
    ).toBe(true);
    a.activities[0]!.variants[1]!.travelOptionsMinutes = [0, 30];
    expect(repairPlan(a).question?.id).toBe("travel:short");
    a.answers = { "travel:short": "skip" };
    expect(repairPlan(a).question).toBeUndefined();
    expect(repairPlan(a).candidates.every((c) => c.variantId !== "short")).toBe(
      true,
    );
  });
  it("asks a relevant resource question, handles several missing requirements and supports skipping", () => {
    const a = input();
    a.resources[0]!.status = "unknown";
    a.resources.push({ id: "mat", label: "Mata", status: "unknown" });
    a.activities[0]!.variants.forEach((v) => (v.resourceIds = ["mat"]));
    const result = repairPlan(a);
    expect(result.candidates).toHaveLength(0);
    expect(result.question).toBeDefined();
    a.answers = { [result.question!.id]: true };
    const second = repairPlan(a);
    expect(second.question).toBeDefined();
    expect(second.question!.id).not.toBe(result.question!.id);
    a.answers[second.question!.id] = true;
    expect(repairPlan(a).candidates.length).toBeGreaterThan(0);
    a.answers = { "resource:home": "skip", "resource:mat": "skip" };
    expect(repairPlan(a).candidates).toHaveLength(0);
    expect(repairPlan(a).question).toBeUndefined();
  });
  it("does not ask about a resource when no admissible answer changes the choices", () => {
    const a = input();
    a.resources.push({
      id: "irrelevant",
      label: "Inna sala",
      status: "unknown",
    });
    expect(repairPlan(a).question).toBeUndefined();
    a.resources[0]!.status = "unknown";
    a.constraints.push({
      id: "ban",
      kind: "exclude",
      mappingState: "confirmed",
    });
    expect(repairPlan(a).question).toBeUndefined();
  });
  it("respects an explicit change of a previously known resource and never guesses after skip", () => {
    const a = input();
    a.answers = { "resource:home": false };
    expect(repairPlan(a).candidates).toHaveLength(0);
    a.answers = { "resource:home": "skip" };
    expect(repairPlan(a).candidates).toHaveLength(0);
    a.answers = { "resource:home": true };
    expect(repairPlan(a).candidates.length).toBeGreaterThan(0);
  });
  it("keeps all accepted events and protected rest as hard constraints", () => {
    const a = input();
    a.protectedWindows = [window("rest", 10, 30, "rest")];
    a.acceptedPlans = [
      {
        ...window("other", 100, 130),
        variantId: "short",
        intentId: "intent",
        status: "accepted",
        revision: 0,
      },
    ];
    const result = repairPlan(a);
    expect(result.conflicts.some((r) => r.code === "PROTECTED_REST")).toBe(
      true,
    );
    expect(
      result.candidates.every(
        (c) =>
          !overlaps(c, a.protectedWindows[0]!) &&
          !overlaps(c, a.acceptedPlans![0]!),
      ),
    ).toBe(true);
    expect(result.candidates.every((c) => c.variantId === "short")).toBe(true);
  });
  it("reserves uncertain travel on other future plans instead of assuming the missing time is free", () => {
    const a = input();
    const unknown = variant("uncertain", 10, { travelMinutes: null });
    a.activities[0]!.variants.push(unknown);
    a.availability = [window("later", 50, 300)];
    a.acceptedPlans = [
      {
        ...window("other-unknown", 50, 60),
        variantId: unknown.id,
        intentId: "intent",
        status: "conflict",
        revision: 0,
      },
    ];
    const unbounded = repairPlan(a);
    expect(unbounded.candidates).toHaveLength(0);
    expect(
      unbounded.conflicts.some(
        (r) =>
          r.code === "MISSING_TRAVEL_TIME" &&
          r.evidenceIds.includes("other-unknown"),
      ),
    ).toBe(true);
    expect(
      unbounded.rejected.some((r) =>
        r.reasonCodes.includes("MISSING_TRAVEL_TIME"),
      ),
    ).toBe(true);
    unknown.travelOptionsMinutes = [10, 30];
    const bounded = repairPlan(a);
    expect(bounded.candidates.length).toBeGreaterThan(0);
    expect(
      bounded.candidates.every((c) => epoch(c.start) >= epoch(minutes(90))),
    ).toBe(true);
    a.answers = { "travel:uncertain": 10 };
    const answered = repairPlan(a);
    expect(answered.candidates[0]!.start).toBe(minutes(70));
  });
  it("honors a full rest day including activities spanning into it and can offer tomorrow", () => {
    const a = input();
    a.restToday = true;
    a.availability = [window("all-week", 0, 7 * 1440)];
    const result = repairPlan(a);
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(
      result.candidates.every(
        (c) => localDate(c.start, a.timezone) !== localDate(now, a.timezone),
      ),
    ).toBe(true);
  });
  it("blocks unreviewed, unsupported and expired consultation rules without expanding permitted movement", () => {
    for (const constraint of [
      {
        id: "unknown",
        kind: "unmapped" as const,
        mappingState: "needs_review" as const,
      },
      {
        id: "expired",
        kind: "max_duration" as const,
        mappingState: "confirmed" as const,
        maxDurationMinutes: 30,
        validUntil: minutes(-1),
      },
    ]) {
      const a = input();
      a.constraints = [constraint];
      const result = repairPlan(a);
      expect(result.candidates).toHaveLength(0);
      expect(
        result.rejected.some((r) =>
          r.reasonCodes.includes("CONSTRAINT_REVIEW_REQUIRED"),
        ),
      ).toBe(true);
      expect(result.alwaysAvailable).toEqual(["rest", "defer"]);
    }
  });
  it("honors activity scope, duration, required resources and limited rule windows", () => {
    const a = input();
    a.constraints = [
      {
        id: "duration",
        kind: "max_duration",
        mappingState: "confirmed",
        maxDurationMinutes: 15,
        activityTypes: ["training"],
      },
    ];
    expect(repairPlan(a).candidates.every((c) => c.durationMinutes <= 15)).toBe(
      true,
    );
    a.constraints = [
      {
        id: "resource",
        kind: "requires_resource",
        mappingState: "confirmed",
        resourceIds: ["mat"],
      },
    ];
    expect(repairPlan(a).candidates).toHaveLength(0);
    a.constraints = [
      {
        id: "period",
        kind: "available",
        mappingState: "confirmed",
        windows: [window("only", 115, 145)],
      },
    ];
    expect(repairPlan(a).candidates).toHaveLength(1);
    expect(repairPlan(a).candidates[0]!.start).toBe(minutes(115));
  });
  it("rejects malformed intervals, unknown zones, negative and missing times and past plans", () => {
    const a = input();
    a.availability[0]!.end = a.availability[0]!.start;
    expect(repairPlan(a).conflicts[0]!.code).toBe("INVALID_INPUT");
    const b = input();
    b.timezone = "Unknown/Place";
    expect(repairPlan(b).conflicts[0]!.code).toBe("INVALID_INPUT");
    const c = input();
    c.activities[0]!.variants[0]!.preparationMinutes = -1;
    expect(repairPlan(c).conflicts[0]!.code).toBe("INVALID_INPUT");
    const d = input();
    d.plan.start = minutes(-1);
    expect(repairPlan(d).conflicts[0]!.code).toBe("PAST_PLAN");
  });
  it("never creates near-identical same-day time cards and is stable when inputs are reordered", () => {
    const a = input();
    a.availability = [window("large", 0, 600)];
    const result = repairPlan(a);
    const keys = result.candidates.map(
      (c) => `${c.variantId}:${localDate(c.start, a.timezone)}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
    a.activities[0]!.variants.reverse();
    expect(repairPlan(a).candidates).toEqual(result.candidates);
  });
  it("checks 1000 generated scenarios with zero hard constraint violations", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            start: fc.integer({ min: 0, max: 9000 }),
            length: fc.integer({ min: 1, max: 300 }),
          }),
          { maxLength: 15 },
        ),
        fc.integer({ min: 1, max: 180 }),
        fc.integer({ min: 0, max: 90 }),
        fc.integer({ min: 0, max: 120 }),
        fc.boolean(),
        (blocks, duration, preparation, travel, restToday) => {
          const a = input();
          a.restToday = restToday;
          a.availability = [window("all", 0, 10080)];
          a.activities[0]!.variants = [
            variant("original", duration, {
              preparationMinutes: preparation,
              travelMinutes: travel,
            }),
          ];
          a.busy = blocks.map((b, i) =>
            window(
              `block-${i}`,
              b.start,
              b.start + b.length,
              i % 2 ? "work" : "buffer",
            ),
          );
          a.protectedWindows = [window("protected", 500, 800, "rest")];
          const result = repairPlan(a);
          expect(result.candidates.length).toBeLessThanOrEqual(3);
          expect(result.alwaysAvailable).toEqual(["rest", "defer"]);
          for (const candidate of result.candidates) {
            expect(epoch(candidate.end) - epoch(candidate.start)).toBe(
              (duration + preparation + travel) * 60000,
            );
            expect(epoch(candidate.start)).toBeGreaterThanOrEqual(epoch(now));
            expect(epoch(candidate.end)).toBeLessThanOrEqual(
              epoch(horizonEnd(now, a.timezone)),
            );
            expect(
              [...a.busy, ...a.protectedWindows].every(
                (b) => !overlaps(candidate, b),
              ),
            ).toBe(true);
            expect(a.availability.some((w) => contains(w, candidate))).toBe(
              true,
            );
            if (restToday)
              expect(localDate(candidate.start, a.timezone)).not.toBe(
                localDate(now, a.timezone),
              );
          }
        },
      ),
      { numRuns: 1000, seed: 20261003 },
    );
  }, 60000);
});

describe("time and chronology", () => {
  it("keeps an interval across midnight continuous and treats touching boundaries as free", () => {
    const available = [
      {
        id: "night",
        start: "2026-10-03T23:30:00+02:00",
        end: "2026-10-04T01:30:00+02:00",
      },
    ];
    const cut = [
      {
        id: "work",
        start: "2026-10-04T00:00:00+02:00",
        end: "2026-10-04T01:00:00+02:00",
      },
    ];
    const result = subtractIntervals(
      available,
      cut,
      available[0]!.start,
      available[0]!.end,
    );
    expect(result).toHaveLength(2);
    expect(
      result.every((r) => (epoch(r.end) - epoch(r.start)) / 60000 === 30),
    ).toBe(true);
    expect(overlaps(result[0]!, cut[0]!)).toBe(false);
  });
  it("rejects nonexistent or ambiguous DST input until an offset is chosen", () => {
    expect(() => resolveLocalTime("2026-03-29T02:30", "Europe/Warsaw")).toThrow(
      "nie istnieje",
    );
    expect(() => resolveLocalTime("2026-10-25T02:30", "Europe/Warsaw")).toThrow(
      "dwukrotnie",
    );
    expect(
      epoch(resolveLocalTime("2026-10-25T02:30", "Europe/Warsaw", 60)) -
        epoch(resolveLocalTime("2026-10-25T02:30", "Europe/Warsaw", 120)),
    ).toBe(3600000);
  });
  it("uses seven local days across DST rather than a fixed number of hours", () => {
    expect(
      (epoch(horizonEnd("2026-10-23T12:00:00Z", "Europe/Warsaw")) -
        epoch("2026-10-23T12:00:00Z")) /
        3600000,
    ).toBe(169);
  });
});

describe("revision state, results and sources", () => {
  it("accepts point measurements and includes a boundary timestamp in source coverage and the selected report", () => {
    const data = createDemoData(now),
      point = {
        id: "weight",
        sourceId: "source-manual",
        metric: "weight",
        value: 72.5,
        unit: "kg",
        start: "2026-09-27T00:00:00+02:00",
        end: "2026-09-27T00:00:00+02:00",
        status: "confirmed" as const,
        revision: 1,
      };
    expect(observationSchema.safeParse(point).success).toBe(true);
    expect(
      observationSchema.safeParse({
        ...point,
        end: "2026-09-26T23:59:59+02:00",
      }).success,
    ).toBe(false);
    data.observations.push(point);
    expect(
      summarizeHistory(data, 7, now).coverage.find((c) => c.metric === "weight")
        ?.coveredDays,
    ).toBe(1);
    expect(
      buildCarePacket(data, {
        start: point.start,
        end: now,
        goal: "Pomiary",
        questions: [],
        observationIds: [point.id],
        documentFactIds: [],
        decisionIds: [],
      }).observationIds,
    ).toEqual([point.id]);
  });
  function ready() {
    const data = createDemoData(now),
      input = createRepairInput(data, "plan-main", now),
      result = repairPlan(input);
    const request: AcceptRevisionRequest = {
      operationId: "one",
      expectedRevision: data.revision,
      input,
      result,
      now,
      choice: { kind: "activity", candidateId: result.candidates[0]!.id },
      obstacle: "Mniej czasu",
    };
    return { data, request };
  }
  it("commits once, protects other plans and keeps decision separate from execution", () => {
    const { data, request } = ready();
    const next = acceptRevision(data, request);
    expect(next.revision).toBe(1);
    expect(next.decisions.length).toBe(data.decisions.length + 1);
    expect(next.outcomes.at(-1)!.status).toBe("no_response");
    expect(next.plans[1]).toEqual(data.plans[1]);
    expect(acceptRevision(next, request)).toBe(next);
    expect(() =>
      acceptRevision(next, { ...request, operationId: "two" }),
    ).toThrow("innej karcie");
    const outcome = {
      id: "actual",
      decisionId: next.decisions.at(-1)!.id,
      status: "different" as const,
      recordedAt: next.decisions.at(-1)!.candidate!.end,
      note: "Własna obserwacja",
    };
    const recorded = recordOutcome(next, outcome);
    expect(recorded.decisions).toEqual(next.decisions);
    expect(recordOutcome(recorded, outcome).outcomes.length).toBe(
      recorded.outcomes.length,
    );
  });
  it("snapshots original and chosen names across successive repairs and later variant edits", () => {
    const { data } = ready();
    const plan = data.plans.find((entry) => entry.id === "plan-main")!;
    delete plan.label; // Legacy records may not have a stored display label.
    const originalName = data.activities
      .flatMap((activity) => activity.variants)
      .find((entry) => entry.id === plan.variantId)!.name;
    const firstInput = createRepairInput(data, plan.id, now);
    const firstResult = repairPlan(firstInput);
    const firstChoice = firstResult.candidates.find(
      (candidate) => candidate.variantId === "walk-15",
    )!;
    const first = acceptRevision(data, {
      operationId: "named-first",
      expectedRevision: data.revision,
      input: firstInput,
      result: firstResult,
      now,
      choice: { kind: "activity", candidateId: firstChoice.id },
    });
    expect(first.plans.find((entry) => entry.id === plan.id)?.label).toBe(
      firstChoice.name,
    );
    const secondInput = createRepairInput(first, plan.id, now);
    const secondResult = repairPlan(secondInput);
    const secondChoice = secondResult.candidates.find(
      (candidate) => candidate.variantId !== firstChoice.variantId,
    )!;
    expect(secondChoice).toBeDefined();
    const second = acceptRevision(first, {
      operationId: "named-second",
      expectedRevision: first.revision,
      input: secondInput,
      result: secondResult,
      now,
      choice: { kind: "activity", candidateId: secondChoice.id },
    });
    const renamed = {
      ...second,
      activities: second.activities.map((activity) => ({
        ...activity,
        variants: activity.variants.map((entry) => ({
          ...entry,
          name: "Później zmieniona nazwa",
        })),
      })),
    };
    const decisions = renamed.decisions.filter((decision) =>
      decision.operationId.startsWith("named-"),
    );
    expect(decisions.map((decision) => decision.originalPlan.label)).toEqual([
      originalName,
      firstChoice.name,
    ]);
    expect(decisions.map((decision) => decision.candidate?.name)).toEqual([
      firstChoice.name,
      secondChoice.name,
    ]);
    expect(renamed.plans.find((entry) => entry.id === plan.id)?.label).toBe(
      secondChoice.name,
    );
  });
  it("rejects a forged candidate, stale rule version and a newly elapsed activity", () => {
    const { data, request } = ready();
    expect(() =>
      acceptRevision(data, {
        ...request,
        choice: { kind: "activity", candidateId: "forged" },
      }),
    ).toThrow("nie jest już potwierdzony");
    expect(() =>
      acceptRevision(data, {
        ...request,
        result: { ...request.result, ruleVersion: "old" },
      }),
    ).toThrow("Dane podglądu");
    expect(() =>
      acceptRevision(data, { ...request, now: minutes(100) }),
    ).toThrow("rozpoczętego");
  });
  it("rest and deferral are persisted without implied execution", () => {
    const { data, request } = ready();
    for (const kind of ["rest", "defer"] as const) {
      const next = acceptRevision(data, { ...request, choice: { kind } });
      expect(next.decisions.at(-1)!.kind).toBe(kind);
      expect(next.outcomes.at(-1)!.status).toBe("no_response");
    }
  });
  it("persists a rest day across later repairs and protects a selected rest interval", () => {
    const { data, request } = ready();
    request.input.restToday = true;
    request.result = repairPlan(request.input);
    const candidate = request.result.candidates[0]!;
    const next = acceptRevision(data, {
      ...request,
      choice: { kind: "activity", candidateId: candidate.id },
    });
    const rest = next.protectedWindows.find((w) =>
      w.id.startsWith("rest-day:"),
    )!;
    expect(rest).toBeDefined();
    expect(localDate(rest.start, data.profile.timezone)).toBe(
      localDate(now, data.profile.timezone),
    );
    const repeated = acceptRevision(next, request);
    expect(repeated).toBe(next);
    const other = input();
    other.acceptedPlans = [
      {
        ...window("chosen-rest", 100, 160),
        variantId: "short",
        intentId: "intent",
        revision: 1,
        status: "rest",
      },
    ];
    expect(
      repairPlan(other).candidates.every(
        (c) => !overlaps(c, other.acceptedPlans![0]!),
      ),
    ).toBe(true);
  });
  it("rejects a preview without moving the original and retains the conflict evidence", () => {
    const { data, request } = ready();
    const next = rejectPreview(data, request.input.plan.id, request.result);
    expect(next.plans[0]!.start).toBe(data.plans[0]!.start);
    expect(next.plans[0]!.status).toBe("conflict");
    expect(next.plans[0]!.conflictReasons).toEqual(request.result.conflicts);
    expect(next.revision).toBe(data.revision + 1);
    expect(() =>
      rejectPreview(next, request.input.plan.id, request.result),
    ).toThrow("Plan zmienił się");
  });
  it("does not accept a declared outcome before the selected activity ends", () => {
    const { data, request } = ready();
    const next = acceptRevision(data, request);
    expect(() =>
      recordOutcome(next, {
        id: "early",
        decisionId: next.decisions.at(-1)!.id,
        status: "done",
        recordedAt: now,
      }),
    ).toThrow("po zakończeniu");
  });
  it("keeps changed availability and confirmed organisational answers in the next repair", () => {
    const { data, request } = ready();
    request.input.availability = request.input.availability.map((w, i) =>
      i
        ? w
        : {
            ...w,
            end: new Date(Date.parse(w.start) + 10 * 60000).toISOString(),
          },
    );
    request.input.answers = { "resource:gym": false, "resource:mat": "skip" };
    request.result = repairPlan(request.input);
    const next = acceptRevision(data, {
      ...request,
      choice: { kind: "defer" },
    });
    expect(next.availability).toEqual(request.input.availability);
    expect(next.resources.find((r) => r.id === "gym")!.status).toBe(
      "unavailable",
    );
    expect(next.resources.find((r) => r.id === "mat")!.status).toBe("unknown");
    const rejected = rejectPreview(
      data,
      request.input.plan.id,
      request.result,
      request.input,
    );
    expect(rejected.availability).toEqual(request.input.availability);
    expect(rejected.plans[0]!.start).toBe(data.plans[0]!.start);
  });
  it("preserves missing outcomes and separate source coverage without summing overlaps", () => {
    const data = createDemoData(now);
    const history = summarizeHistory(data, 7, now);
    expect(history.counts).toMatchObject({
      decisions: 3,
      done: 2,
      noResponse: 1,
    });
    expect(
      history.similar.find((s) => s.variantId === "walk-15"),
    ).toMatchObject({ chosen: 3, done: 2, noResponse: 1 });
    expect(
      history.coverage.find((c) => c.sourceId === "source-sleep"),
    ).toMatchObject({ coveredDays: 4, totalDays: 7 });
    expect(
      history.coverage.find((c) => c.sourceId === "source-document"),
    ).toMatchObject({ coveredDays: 0 });
  });
  it("marks dependent future plans and reports stale on source correction without rewriting decision history", () => {
    const { data, request } = ready();
    const committed = acceptRevision(data, request);
    committed.carePackets = [
      buildCarePacket(committed, {
        start: minutes(-10080),
        end: minutes(1),
        goal: "Cel",
        questions: [],
        observationIds: [],
        documentFactIds: ["fact-confirmed"],
        decisionIds: [],
        now,
      }),
    ];
    const next = correctSource(committed, "source-manual", now);
    expect(next.plans[0]!.needsRevalidation).toBe(true);
    expect(next.decisions).toEqual(committed.decisions);
    const report = correctSource(committed, "source-document", now);
    expect(report.carePackets[0]!.stale).toBe(true);
  });
  it("removes source content from observations, snapshots and reports and retains only a tombstone", () => {
    const { data, request } = ready();
    const committed = acceptRevision(data, request);
    committed.constraints.push({
      id: "consultation",
      sourceId: "source-manual",
      sourceText: "SENSITIVE",
      kind: "max_duration",
      maxDurationMinutes: 50,
      mappingState: "confirmed",
    });
    const next = deleteSource(committed, "source-manual", now);
    expect(next.sources.find((s) => s.id === "source-manual")!.name).toBe(
      "Źródło usunięto",
    );
    expect(
      next.decisions
        .filter((d) => d.sourceRemoved)
        .every((d) => d.candidate === undefined),
    ).toBe(true);
    expect(next.revisions[0]!.candidates).toEqual([]);
    expect(JSON.stringify(next)).not.toContain("SENSITIVE");
    expect(
      next.constraints.some(
        (c) => c.kind === "unmapped" && c.mappingState === "needs_review",
      ),
    ).toBe(true);
  });
  it("exports only explicitly selected confirmed facts and rejects unknown source references", () => {
    const data = createDemoData(now);
    const selection = {
      start: minutes(-10080),
      end: minutes(1),
      goal: "Rozmowa",
      questions: ["Moje pytanie"],
      observationIds: ["sleep-1"],
      documentFactIds: ["fact-confirmed"],
      decisionIds: [],
      now,
    };
    const packet = buildCarePacket(data, selection);
    expect(packet.documentFactIds).toEqual(["fact-confirmed"]);
    expect(packet.synthetic).toBe(true);
    expect(() =>
      buildCarePacket(data, {
        ...selection,
        documentFactIds: ["fact-pending"],
      }),
    ).toThrow("Potwierdź");
    data.sources = data.sources.filter((s) => s.id !== "source-sleep");
    expect(() => buildCarePacket(data, selection)).toThrow("nieznane źródło");
  });
});
