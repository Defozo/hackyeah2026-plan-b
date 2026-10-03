import { DateTime } from "luxon";
import type {
  ActivityVariant,
  Candidate,
  CandidateDiagnostic,
  Constraint,
  Interval,
  Priority,
  ReasonCode,
  RepairInput,
  RepairQuestion,
  RepairResult,
  RuleEvidence,
} from "./types";
import {
  assertTimezone,
  contains,
  epoch,
  horizonEnd,
  iso,
  localDate,
  localTime,
  overlaps,
  preferredInstants,
  subtractIntervals,
  validateInterval,
  withTimeMemo,
} from "./time";
import { repairInputSchema } from "./schemas";

export const RULE_VERSION = "planb-rules-1.0.0";
const unique = <T>(values: T[]): T[] => [...new Set(values)];
const evidence = (
  code: ReasonCode,
  ids: string[],
  message: string,
): RuleEvidence => ({ code, evidenceIds: unique(ids), message });
const diag = (
  variantId: string,
  reasons: RuleEvidence[],
  start?: string,
  end?: string,
  unknownIds: string[] = [],
): CandidateDiagnostic => ({
  variantId,
  start,
  end,
  reasons,
  reasonCodes: unique(reasons.map((r) => r.code)),
  evidenceIds: unique(reasons.flatMap((r) => r.evidenceIds)),
  unknownIds: unique(unknownIds),
});
const applies = (constraint: Constraint, variant: ActivityVariant): boolean =>
  (!constraint.activityTypes?.length && !constraint.variantIds?.length) ||
  !!constraint.activityTypes?.includes(variant.activityType) ||
  !!constraint.variantIds?.includes(variant.id);

function validate(input: RepairInput): void {
  assertTimezone(input.timezone);
  epoch(input.now);
  validateInterval(input.plan);
  if (!Number.isInteger(input.inputVersion) || input.inputVersion < 0)
    throw new Error("Nieprawidłowa wersja wejścia.");
  const all = [
    ...input.availability,
    ...input.busy,
    ...input.protectedWindows,
    ...(input.acceptedPlans ?? []),
  ];
  all.forEach(validateInterval);
  for (const resource of input.resources)
    resource.windows?.forEach(validateInterval);
  for (const constraint of input.constraints) {
    constraint.windows?.forEach(validateInterval);
    if (constraint.validFrom) epoch(constraint.validFrom);
    if (constraint.validUntil) epoch(constraint.validUntil);
    if (
      constraint.validFrom &&
      constraint.validUntil &&
      epoch(constraint.validFrom) >= epoch(constraint.validUntil)
    )
      throw new Error("Błędny okres ograniczenia.");
    if (
      constraint.kind === "max_duration" &&
      (!Number.isFinite(constraint.maxDurationMinutes) ||
        constraint.maxDurationMinutes! < 0)
    )
      throw new Error("Brak poprawnego maksymalnego czasu.");
    if (constraint.kind === "available" && !constraint.windows?.length)
      throw new Error("Brak przedziałów ograniczenia.");
    if (
      constraint.kind === "requires_resource" &&
      !constraint.resourceIds?.length
    )
      throw new Error("Brak wymaganego zasobu.");
  }
  const ids = new Set<string>();
  for (const variant of input.activities.flatMap((a) => a.variants)) {
    if (ids.has(variant.id))
      throw new Error("Powtórzony identyfikator wariantu.");
    ids.add(variant.id);
    for (const duration of [
      variant.durationMinutes,
      variant.preparationMinutes,
      ...(variant.travelMinutes === null ? [] : [variant.travelMinutes]),
      ...(variant.travelOptionsMinutes ?? []),
    ]) {
      if (!Number.isFinite(duration) || duration < 0 || duration > 10080)
        throw new Error("Nieprawidłowy czas aktywności.");
    }
    if (variant.durationMinutes <= 0 || !variant.locationId)
      throw new Error("Brak czasu lub miejsca aktywności.");
  }
  for (const minute of [
    ...(input.preferredStartMinutes ?? []),
    ...input.activities.flatMap((a) =>
      a.variants.flatMap((v) => v.preferredStartMinutes ?? []),
    ),
  ]) {
    if (!Number.isInteger(minute) || minute < 0 || minute >= 1440)
      throw new Error("Nieprawidłowa preferowana pora.");
  }
  if (!ids.has(input.plan.variantId))
    throw new Error("Nie znaleziono pierwotnego wariantu.");
}

type OccupiedInterval = Interval & {
  unknownTravel?: boolean;
  variantId?: string;
};
function occupied(input: RepairInput): OccupiedInterval[] {
  return [
    ...input.busy,
    ...input.protectedWindows.map((w) => ({ ...w, kind: "rest" as const })),
    ...(input.acceptedPlans ?? [])
      .filter((p) => p.id !== input.plan.id && p.status !== "deferred")
      .map((p) => {
        if (p.status === "rest") return { ...p, kind: "rest" as const };
        const variant = input.activities
          .flatMap((a) => a.variants)
          .find((v) => v.id === p.variantId);
        const answer = input.answers?.[`travel:${p.variantId}`];
        const knownTravel =
          variant?.travelMinutes ??
          (typeof answer === "number" &&
          variant?.travelOptionsMinutes?.includes(answer)
            ? answer
            : undefined);
        const unknownTravel = knownTravel === undefined;
        const boundedTravel =
          knownTravel ??
          (variant?.travelOptionsMinutes?.length
            ? Math.max(...variant.travelOptionsMinutes)
            : undefined);
        const reservedEnd =
          variant && boundedTravel !== undefined
            ? epoch(p.start) +
              (variant.durationMinutes +
                variant.preparationMinutes +
                boundedTravel) *
                60000
            : epoch(horizonEnd(input.now, input.timezone));
        return {
          ...p,
          end: iso(Math.max(epoch(p.end), reservedEnd)),
          kind: "activity" as const,
          unknownTravel,
        };
      }),
  ];
}
function collisionReason(interval: OccupiedInterval): RuleEvidence {
  if (interval.unknownTravel)
    return evidence(
      "MISSING_TRAVEL_TIME",
      [
        interval.id,
        ...(interval.variantId ? [interval.variantId] : []),
        ...(interval.sourceId ? [interval.sourceId] : []),
      ],
      "Inny zapisany zamiar ma nieznany czas dojazdu. Jego czas jest zarezerwowany do największego wskazanego czasu lub końca horyzontu, dopóki nie uzupełnisz danych.",
    );
  const code: ReasonCode =
    interval.kind === "rest"
      ? "PROTECTED_REST"
      : interval.kind === "buffer"
        ? "BUFFER_CONFLICT"
        : interval.kind === "activity"
          ? "ACCEPTED_PLAN_CONFLICT"
          : "WORK_CONFLICT";
  return evidence(
    code,
    [interval.id, ...(interval.sourceId ? [interval.sourceId] : [])],
    code === "PROTECTED_REST"
      ? "Ten przedział jest chronionym odpoczynkiem."
      : code === "ACCEPTED_PLAN_CONFLICT"
        ? "Inna zaakceptowana pozycja pozostaje chroniona."
        : code === "BUFFER_CONFLICT"
          ? "Ten przedział zawiera zarezerwowany bufor."
          : "Ten termin koliduje z zajętym grafikiem.",
  );
}
function requirements(
  input: RepairInput,
  variant: ActivityVariant,
  slot: Interval,
): { reasons: RuleEvidence[]; unknowns: string[] } {
  const reasons: RuleEvidence[] = [],
    unknowns: string[] = [];
  if (!variant.confirmed)
    reasons.push(
      evidence(
        "UNCONFIRMED_VARIANT",
        [variant.id],
        "Wariant wymaga potwierdzenia użytkownika.",
      ),
    );
  if (!variant.intentIds.includes(input.intent.id) && !input.allowIntentChange)
    reasons.push(
      evidence(
        "INTENT_CHANGED",
        [variant.id, input.intent.id],
        "Ten wariant zmienia cel i wymaga osobnej zgody.",
      ),
    );
  if (input.restToday) {
    const day = DateTime.fromMillis(epoch(input.now), {
      zone: input.timezone,
    }).startOf("day");
    if (
      overlaps(slot, {
        start: day.toUTC().toISO()!,
        end: day.plus({ days: 1 }).toUTC().toISO()!,
      })
    )
      reasons.push(
        evidence(
          "REST_TODAY",
          [input.plan.id],
          "Wybrano odpoczynek na dzisiaj.",
        ),
      );
  }
  const resources = [...variant.resourceIds, variant.locationId];
  for (const constraint of input.constraints.filter((c) =>
    applies(c, variant),
  )) {
    if (constraint.validFrom && epoch(slot.end) <= epoch(constraint.validFrom))
      continue;
    const expired =
      !!constraint.validUntil && epoch(slot.end) > epoch(constraint.validUntil);
    if (
      expired ||
      constraint.mappingState !== "confirmed" ||
      constraint.kind === "unmapped"
    ) {
      reasons.push(
        evidence(
          "CONSTRAINT_REVIEW_REQUIRED",
          [
            constraint.id,
            ...(constraint.sourceId ? [constraint.sourceId] : []),
          ],
          expired
            ? "Ograniczenie wygasa przed końcem wariantu. Potrzebny jest przegląd."
            : "Ustalenie wymaga wyjaśnienia przed automatycznym doborem aktywności.",
        ),
      );
      continue;
    }
    if (constraint.kind === "exclude")
      reasons.push(
        evidence(
          "ACTIVITY_EXCLUDED",
          [constraint.id],
          "Ta czynność jest wykluczona w podanym okresie.",
        ),
      );
    if (
      constraint.kind === "max_duration" &&
      variant.durationMinutes > constraint.maxDurationMinutes!
    )
      reasons.push(
        evidence(
          "MAX_DURATION",
          [constraint.id],
          `Czas aktywności ${variant.durationMinutes} min przekracza potwierdzony limit ${constraint.maxDurationMinutes} min.`,
        ),
      );
    if (constraint.kind === "requires_resource")
      resources.push(...constraint.resourceIds!);
    if (
      constraint.kind === "available" &&
      !constraint.windows!.some((w) => contains(w, slot))
    )
      reasons.push(
        evidence(
          "OUTSIDE_AVAILABILITY",
          [constraint.id],
          "Wariant wykracza poza przedział potwierdzonego ograniczenia.",
        ),
      );
  }
  for (const id of unique(resources)) {
    const resource = input.resources.find((r) => r.id === id),
      answer = input.answers?.[`resource:${id}`];
    const available =
      typeof answer === "boolean"
        ? answer
        : answer === "skip"
          ? undefined
          : resource?.status === "available"
            ? true
            : resource?.status === "unavailable"
              ? false
              : undefined;
    if (available === undefined) {
      reasons.push(
        evidence(
          "RESOURCE_UNKNOWN",
          [id],
          `Brak potwierdzenia dostępności: ${resource?.label ?? id}.`,
        ),
      );
      unknowns.push(`resource:${id}`);
    } else if (
      !available ||
      (resource?.windows && !resource.windows.some((w) => contains(w, slot)))
    ) {
      reasons.push(
        evidence(
          "RESOURCE_UNAVAILABLE",
          [id],
          `Zasób jest niedostępny w tym terminie: ${resource?.label ?? id}.`,
        ),
      );
    }
  }
  return { reasons, unknowns };
}

function makeCandidate(
  input: RepairInput,
  variant: ActivityVariant,
  base: ActivityVariant,
  slot: Interval,
  travel: number,
): Candidate {
  const shift = (epoch(slot.start) - epoch(input.plan.start)) / 60000;
  const changes = {
    activity: variant.activityType !== base.activityType,
    duration: variant.durationMinutes !== base.durationMinutes,
    time: shift !== 0,
    location: variant.locationId !== base.locationId,
    companionship: variant.companionship !== base.companionship,
    count: 0,
    startShiftMinutes: shift,
    durationDeltaMinutes: variant.durationMinutes - base.durationMinutes,
  };
  changes.count = [
    changes.activity,
    changes.duration,
    changes.time,
    changes.location,
    changes.companionship,
  ].filter(Boolean).length;
  const intentPreserved = variant.intentIds.includes(input.intent.id);
  const reasons: RuleEvidence[] = [
    evidence(
      intentPreserved ? "INTENT_PRESERVED" : "INTENT_CHANGED",
      [input.intent.id, variant.id],
      intentPreserved
        ? `Zachowujesz zamiar: ${input.intent.label}.`
        : "Ten wybór wymaga zaakceptowanej zmiany celu.",
    ),
  ];
  if (changes.time)
    reasons.push(
      evidence(
        "TIME_CHANGED",
        [input.plan.id],
        `Początek przesunięty o ${shift} min.`,
      ),
    );
  if (changes.duration)
    reasons.push(
      evidence(
        "DURATION_CHANGED",
        [input.plan.id, variant.id],
        `Czas czynności zmienia się o ${changes.durationDeltaMinutes} min. To nie jest ta sama dawka treningu.`,
      ),
    );
  if (changes.location)
    reasons.push(
      evidence(
        "LOCATION_CHANGED",
        [base.id, variant.id],
        "Zmieniasz miejsce aktywności.",
      ),
    );
  if (changes.activity)
    reasons.push(
      evidence(
        "ACTIVITY_CHANGED",
        [base.id, variant.id],
        "Zmieniasz typ czynności.",
      ),
    );
  if (changes.companionship)
    reasons.push(
      evidence(
        "COMPANIONSHIP_CHANGED",
        [base.id, variant.id],
        "Zmieniasz warunek towarzystwa.",
      ),
    );
  const priorityCosts: Record<Priority, number> = {
    activity: Number(changes.activity),
    duration: Math.abs(changes.durationDeltaMinutes),
    time: Math.abs(shift),
    location: Number(changes.location),
    companionship: Number(changes.companionship),
  };
  const local = DateTime.fromMillis(epoch(slot.start), {
    zone: input.timezone,
  });
  const pref =
    variant.preferredStartMinutes ?? input.preferredStartMinutes ?? [];
  const clockMinute = local.hour * 60 + local.minute;
  const preferenceDistance = pref.length
    ? Math.min(
        ...pref.map((p) =>
          Math.min(Math.abs(p - clockMinute), 1440 - Math.abs(p - clockMinute)),
        ),
      )
    : 0;
  const previousChoices = (input.history ?? []).filter(
    (d) =>
      d.candidate?.variantId === variant.id && d.intentId === input.intent.id,
  ).length;
  return {
    id: `${variant.id}@${slot.start}`,
    variantId: variant.id,
    templateId: variant.templateId,
    name: variant.name,
    start: slot.start,
    end: slot.end,
    timezone: input.timezone,
    originalLocalStart: localTime(slot.start, input.timezone),
    originalLocalEnd: localTime(slot.end, input.timezone),
    totalMinutes: variant.durationMinutes + variant.preparationMinutes + travel,
    durationMinutes: variant.durationMinutes,
    preparationMinutes: variant.preparationMinutes,
    travelMinutes: travel,
    intentPreserved,
    intentId: intentPreserved
      ? input.intent.id
      : (variant.intentIds[0] ?? input.intent.id),
    locationId: variant.locationId,
    changes,
    reasons,
    reasonCodes: reasons.map((r) => r.code),
    evidenceIds: unique(reasons.flatMap((r) => r.evidenceIds)),
    rank: [
      Number(!intentPreserved),
      ...input.priorities.map((p) => priorityCosts[p]),
      changes.count,
      Math.abs(shift),
      Math.abs(changes.durationDeltaMinutes),
      preferenceDistance,
      variant.preferenceRank ?? 0,
      -previousChoices,
    ],
    sourceIds: unique([
      ...(variant.sourceId ? [variant.sourceId] : []),
      ...input.constraints
        .filter((c) => applies(c, variant))
        .flatMap((c) => (c.sourceId ? [c.sourceId] : [])),
      ...input.availability
        .filter((w) => contains(w, slot))
        .flatMap((w) => (w.sourceId ? [w.sourceId] : [])),
      ...input.resources
        .filter((r) =>
          [variant.locationId, ...variant.resourceIds].includes(r.id),
        )
        .flatMap((r) => (r.sourceId ? [r.sourceId] : [])),
    ]),
  };
}
function compare(a: Candidate, b: Candidate): number {
  for (let i = 0; i < a.rank.length; i++)
    if (a.rank[i] !== b.rank[i]) return a.rank[i]! - b.rank[i]!;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
function distinct(candidates: Candidate[], timezone: string): Candidate[] {
  const selected: Candidate[] = [];
  for (const candidate of candidates.sort(compare)) {
    if (
      selected.some(
        (previous) =>
          previous.variantId === candidate.variantId &&
          localDate(previous.start, timezone) ===
            localDate(candidate.start, timezone),
      )
    )
      continue;
    // One variant can occupy at most two cards, leaving room for a genuinely different activity.
    if (
      selected.filter((previous) => previous.variantId === candidate.variantId)
        .length >= 2
    )
      continue;
    selected.push(candidate);
    if (selected.length === 3) break;
  }
  return selected;
}

function core(input: RepairInput): RepairResult {
  const output: RepairResult = {
    ruleVersion: RULE_VERSION,
    inputVersion: input.inputVersion,
    candidates: [],
    conditional: [],
    rejected: [],
    conflicts: [],
    freeWindows: [],
    alwaysAvailable: ["rest", "defer"],
    status: "no_confirmed_option",
  };
  try {
    validate(input);
  } catch (error) {
    output.conflicts.push(
      evidence(
        "INVALID_INPUT",
        [],
        error instanceof Error ? error.message : "Nieprawidłowe dane.",
      ),
    );
    return output;
  }
  if (epoch(input.plan.start) < epoch(input.now)) {
    output.conflicts.push(
      evidence(
        "PAST_PLAN",
        [input.plan.id],
        "Przeszłego lub rozpoczętego działania nie przesuwamy.",
      ),
    );
    return output;
  }
  const blocked = occupied(input),
    until = horizonEnd(input.now, input.timezone);
  output.freeWindows = subtractIntervals(
    input.availability,
    blocked,
    input.now,
    until,
  );
  const variants = input.activities.flatMap((a) => a.variants),
    base = variants.find((v) => v.id === input.plan.variantId)!;
  const baseTravelAnswer = input.answers?.[`travel:${base.id}`];
  const baseTravel =
    base.travelMinutes ??
    (typeof baseTravelAnswer === "number" &&
    base.travelOptionsMinutes?.includes(baseTravelAnswer)
      ? baseTravelAnswer
      : null);
  const baseSlot = {
    ...input.plan,
    end:
      baseTravel === null
        ? input.plan.end
        : iso(
            epoch(input.plan.start) +
              (base.durationMinutes + base.preparationMinutes + baseTravel) *
                60000,
          ),
  };
  output.conflicts.push(
    ...blocked.filter((b) => overlaps(baseSlot, b)).map(collisionReason),
  );
  if (baseTravel === null)
    output.conflicts.push(
      evidence(
        "MISSING_TRAVEL_TIME",
        [base.id],
        "Brakuje czasu dojazdu, aby sprawdzić ten wariant.",
      ),
    );
  if (!output.freeWindows.some((w) => contains(w, baseSlot))) {
    const window = output.freeWindows.find(
      (w) =>
        epoch(w.start) <= epoch(baseSlot.start) &&
        epoch(w.end) > epoch(baseSlot.start),
    );
    const needed =
      baseTravel === null
        ? null
        : base.durationMinutes + base.preparationMinutes + baseTravel;
    const available = window
      ? Math.max(0, (epoch(window.end) - epoch(baseSlot.start)) / 60000)
      : 0;
    output.conflicts.push(
      evidence(
        "INSUFFICIENT_TIME",
        [input.plan.id, ...input.availability.map((w) => w.id)],
        needed === null
          ? "Brakuje potwierdzonego pełnego kosztu czasu."
          : `Potrzebujesz ${needed} minut, masz ${available}.`,
      ),
    );
  }
  output.conflicts.push(...requirements(input, base, baseSlot).reasons);
  const found: Candidate[] = [];
  for (const variant of variants) {
    const answer = input.answers?.[`travel:${variant.id}`];
    const travel =
      variant.travelMinutes ??
      (typeof answer === "number" &&
      variant.travelOptionsMinutes?.includes(answer)
        ? answer
        : null);
    if (travel === null) {
      output.conditional.push(
        diag(
          variant.id,
          [
            evidence(
              "MISSING_TRAVEL_TIME",
              [variant.id],
              "Brakuje czasu dojazdu, aby sprawdzić ten wariant.",
            ),
          ],
          undefined,
          undefined,
          [`travel:${variant.id}`],
        ),
      );
      continue;
    }
    const total = variant.durationMinutes + variant.preparationMinutes + travel;
    let generated = 0;
    for (const window of output.freeWindows) {
      const minimum = epoch(window.start),
        maximum = epoch(window.end) - total * 60000;
      if (maximum < minimum) continue;
      const baseLocal = DateTime.fromMillis(epoch(input.plan.start), {
        zone: input.timezone,
      });
      const starts = unique([
        minimum,
        maximum,
        Math.min(maximum, Math.max(minimum, epoch(input.plan.start))),
        ...preferredInstants(
          window,
          unique([
            0,
            baseLocal.hour * 60 + baseLocal.minute,
            ...(variant.preferredStartMinutes ??
              input.preferredStartMinutes ??
              []),
          ]),
          input.timezone,
        ),
        ...input.resources.flatMap((r) =>
          (r.windows ?? []).flatMap((w) => [
            epoch(w.start),
            epoch(w.end) - total * 60000,
          ]),
        ),
        ...input.constraints.flatMap((c) => [
          ...(c.windows ?? []).flatMap((w) => [
            epoch(w.start),
            epoch(w.end) - total * 60000,
          ]),
          ...(c.validFrom
            ? [epoch(c.validFrom), epoch(c.validFrom) - total * 60000]
            : []),
        ]),
      ])
        .filter((start) => start >= minimum && start <= maximum)
        .sort((a, b) => a - b);
      for (const start of starts) {
        generated++;
        const slot: Interval = {
          id: `candidate:${variant.id}:${start}`,
          start: iso(start),
          end: iso(start + total * 60000),
        };
        const { reasons, unknowns } = requirements(input, variant, slot);
        if (reasons.length) {
          const item = diag(
            variant.id,
            reasons,
            slot.start,
            slot.end,
            unknowns,
          );
          if (reasons.every((r) => r.code === "RESOURCE_UNKNOWN"))
            output.conditional.push(item);
          else output.rejected.push(item);
        } else found.push(makeCandidate(input, variant, base, slot, travel));
      }
    }
    if (!generated)
      output.rejected.push(
        diag(variant.id, [
          evidence(
            "INSUFFICIENT_TIME",
            [variant.id, ...input.availability.map((w) => w.id)],
            `Pełny czas ${total} min nie mieści się w żadnym potwierdzonym wolnym oknie.`,
          ),
          ...blocked.filter((b) => b.unknownTravel).map(collisionReason),
        ]),
      );
  }
  output.candidates = distinct(found, input.timezone);
  output.status = output.candidates.length
    ? "options"
    : output.conditional.length
      ? "needs_information"
      : "no_confirmed_option";
  return output;
}

/** No inference, random source or wall clock is consulted by the repair engine. */
export function repairPlan(input: RepairInput): RepairResult {
  return withTimeMemo(() => repairWithMemo(input));
}

function repairWithMemo(input: RepairInput): RepairResult {
  const valid = repairInputSchema.safeParse(input);
  if (!valid.success)
    return {
      ruleVersion: RULE_VERSION,
      inputVersion: Number.isInteger(input?.inputVersion)
        ? input.inputVersion
        : 0,
      candidates: [],
      conditional: [],
      rejected: [],
      conflicts: [
        evidence(
          "INVALID_INPUT",
          [],
          valid.error.issues[0]?.message ?? "Nieprawidłowe dane.",
        ),
      ],
      freeWindows: [],
      alwaysAvailable: ["rest", "defer"],
      status: "no_confirmed_option",
    };
  const result = core(input);
  if (
    result.conflicts.some(
      (r) => r.code === "INVALID_INPUT" || r.code === "PAST_PLAN",
    )
  )
    return result;
  const questions: RepairQuestion[] = [];
  const requiredResourceIds = unique(
    input.activities
      .flatMap((a) =>
        a.variants.flatMap((v) => [v.locationId, ...v.resourceIds]),
      )
      .concat(input.constraints.flatMap((c) => c.resourceIds ?? [])),
  );
  const unknownResources = requiredResourceIds
    .map(
      (id) =>
        input.resources.find((r) => r.id === id) ?? {
          id,
          label: id,
          status: "unknown" as const,
        },
    )
    .filter((r) => r.status === "unknown");
  for (const resource of unknownResources) {
    questions.push({
      id: `resource:${resource.id}`,
      subjectId: resource.id,
      kind: "resource",
      text: `Czy masz dostęp do: ${resource.label}?`,
      options: [
        { value: true, label: "Tak" },
        { value: false, label: "Nie" },
      ],
      affectedVariantIds: [],
    });
  }
  for (const variant of input.activities
    .flatMap((a) => a.variants)
    .filter(
      (v) => v.travelMinutes === null && !!v.travelOptionsMinutes?.length,
    )) {
    questions.push({
      id: `travel:${variant.id}`,
      subjectId: variant.id,
      kind: "travel",
      text: `Ile minut zajmie łącznie dojazd dla „${variant.name}”?`,
      options: unique(variant.travelOptionsMinutes!).map((value) => ({
        value,
        label: `${value} min`,
      })),
      affectedVariantIds: [],
    });
  }
  const relevant = questions
    .filter((q) => input.answers?.[q.id] === undefined)
    .map((question) => {
      const outcomes = question.options.map((option) =>
        core({
          ...input,
          answers: { ...input.answers, [question.id]: option.value },
        }),
      );
      let signatures = unique(
        outcomes.map((outcome) =>
          outcome.candidates.map((c) => `${c.id}:${c.totalMinutes}`).join("|"),
        ),
      );
      let variants = unique(
        outcomes.flatMap((outcome) =>
          outcome.candidates.map((c) => c.variantId),
        ),
      );
      if (signatures.length <= 1) {
        // Counterfactual only: evaluate whether another admissible answer can make this
        // question relevant. These assumptions NEVER enter the returned candidates.
        const hypothetical = { ...input.answers };
        for (const other of questions.filter(
          (q) => q.id !== question.id && input.answers?.[q.id] === undefined,
        )) {
          hypothetical[other.id] =
            other.kind === "resource"
              ? true
              : Math.min(...other.options.map((o) => Number(o.value)));
        }
        const dependent = question.options.map((option) =>
          core({
            ...input,
            answers: { ...hypothetical, [question.id]: option.value },
          }),
        );
        signatures = unique(
          dependent.map((outcome) =>
            outcome.candidates
              .map((c) => `${c.id}:${c.totalMinutes}`)
              .join("|"),
          ),
        );
        variants = unique(
          dependent.flatMap((outcome) =>
            outcome.candidates.map((c) => c.variantId),
          ),
        );
      }
      return {
        question: { ...question, affectedVariantIds: variants },
        value: signatures.length > 1 ? variants.length : 0,
      };
    })
    .filter((q) => q.value > 0)
    .sort(
      (a, b) =>
        b.value - a.value ||
        a.question.options.length - b.question.options.length ||
        a.question.id.localeCompare(b.question.id),
    );
  if (relevant[0]) result.question = relevant[0].question;
  return result;
}
