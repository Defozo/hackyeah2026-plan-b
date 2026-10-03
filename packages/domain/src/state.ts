import { DateTime } from "luxon";
import { repairPlan, RULE_VERSION } from "./engine";
import { epoch, overlaps } from "./time";
import type {
  AcceptRevisionRequest,
  CarePacket,
  Decision,
  DomainData,
  Outcome,
  PlanStore,
  RepairInput,
  Source,
} from "./types";

export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

/** Organisational answers are saved with the decision, so the next repair uses the same confirmed context. */
function persistRepairContext<T extends PlanStore>(
  store: T,
  input: RepairInput,
): T {
  const required = [
    ...new Set(
      input.activities
        .flatMap((a) =>
          a.variants.flatMap((v) => [v.locationId, ...v.resourceIds]),
        )
        .concat(input.constraints.flatMap((c) => c.resourceIds ?? [])),
    ),
  ];
  const resources = [
    ...input.resources,
    ...required
      .filter((id) => !input.resources.some((r) => r.id === id))
      .map((id) => ({ id, label: id, status: "unknown" as const })),
  ];
  return {
    ...store,
    ...("availability" in store
      ? { availability: structuredClone(input.availability) }
      : {}),
    ...("resources" in store
      ? {
          resources: resources.map((resource) => {
            const answer = input.answers?.[`resource:${resource.id}`];
            return answer === undefined
              ? resource
              : {
                  ...resource,
                  status:
                    answer === true
                      ? ("available" as const)
                      : answer === false
                        ? ("unavailable" as const)
                        : ("unknown" as const),
                };
          }),
        }
      : {}),
    ...("activities" in store
      ? {
          activities: input.activities.map((activity) => ({
            ...activity,
            variants: activity.variants.map((variant) => {
              const answer = input.answers?.[`travel:${variant.id}`];
              return variant.travelMinutes === null &&
                typeof answer === "number" &&
                variant.travelOptionsMinutes?.includes(answer)
                ? { ...variant, travelMinutes: answer }
                : variant;
            }),
          })),
        }
      : {}),
  };
}

/** Caller persists this returned state in one transaction with the same revision check. */
export function acceptRevision<T extends PlanStore>(
  store: T,
  request: AcceptRevisionRequest,
): T {
  if (!request.operationId.trim())
    throw new DomainError(
      "INVALID_OPERATION",
      "Brakuje identyfikatora operacji.",
    );
  if (store.decisions.some((d) => d.operationId === request.operationId))
    return store;
  if (store.revision !== request.expectedRevision)
    throw new DomainError(
      "REVISION_CONFLICT",
      "Plan zmienił się w innej karcie. Odczytaj dane i przelicz ponownie.",
    );
  const original = store.plans.find((p) => p.id === request.input.plan.id);
  if (
    !original ||
    request.input.inputVersion !== store.revision ||
    original.revision !== request.input.plan.revision ||
    original.start !== request.input.plan.start ||
    original.variantId !== request.input.plan.variantId ||
    request.result.inputVersion !== request.input.inputVersion ||
    request.result.ruleVersion !== RULE_VERSION
  ) {
    throw new DomainError(
      "STALE_INPUT",
      "Dane podglądu zmieniły się. Przelicz warianty.",
    );
  }
  if (epoch(original.start) < epoch(request.now))
    throw new DomainError(
      "PAST_PLAN",
      "Nie można przesuwać rozpoczętego lub przeszłego działania.",
    );
  const fresh = repairPlan({
    ...request.input,
    now: request.now,
    acceptedPlans: store.plans,
  });
  const candidate =
    request.choice.kind === "activity"
      ? fresh.candidates.find(
          (c) =>
            c.id === (request.choice as { candidateId: string }).candidateId,
        )
      : undefined;
  if (request.choice.kind === "activity" && !candidate)
    throw new DomainError(
      "INVALID_CHOICE",
      "Wybrany wariant nie jest już potwierdzony. Przelicz plan.",
    );
  const revision = store.revision + 1;
  const decision: Decision = {
    id: `decision:${request.operationId}`,
    operationId: request.operationId,
    planId: original.id,
    revision,
    createdAt: request.now,
    kind: request.choice.kind,
    candidate,
    intentId: request.input.intent.id,
    obstacle: request.obstacle,
    originalPlan: {
      ...structuredClone(original),
      label:
        original.label ??
        request.input.activities
          .flatMap((activity) => activity.variants)
          .find((variant) => variant.id === original.variantId)?.name,
    },
    sourceIds: [
      ...new Set([
        ...(candidate?.sourceIds ?? []),
        ...(original.sourceId ? [original.sourceId] : []),
        ...request.input.constraints.flatMap((c) =>
          c.sourceId ? [c.sourceId] : [],
        ),
      ]),
    ],
  };
  const changed = candidate
    ? {
        ...original,
        label: candidate.name,
        start: candidate.start,
        end: candidate.end,
        originalLocalStart: candidate.originalLocalStart,
        originalLocalEnd: candidate.originalLocalEnd,
        timezone: candidate.timezone,
        variantId: candidate.variantId,
        intentId: candidate.intentId,
        revision,
        status: "accepted" as const,
        needsRevalidation: false,
        conflictReasons: undefined,
      }
    : {
        ...original,
        revision,
        status:
          request.choice.kind === "rest"
            ? ("rest" as const)
            : ("deferred" as const),
        needsRevalidation: false,
        conflictReasons: undefined,
      };
  const restDay = DateTime.fromISO(request.now, {
    zone: request.input.timezone,
  }).startOf("day");
  const restId = `rest-day:${restDay.toISODate()}:${request.input.timezone}`;
  const restWindow = {
    id: restId,
    start: restDay.toUTC().toISO()!,
    end: restDay.plus({ days: 1 }).toUTC().toISO()!,
    timezone: request.input.timezone,
    kind: "rest" as const,
    label: "Dzisiaj odpoczywam",
  };
  const persistedRest =
    request.input.restToday && "protectedWindows" in store
      ? {
          protectedWindows: [
            ...request.input.protectedWindows.filter((w) => w.id !== restId),
            restWindow,
          ],
        }
      : {};
  return {
    ...persistRepairContext(store, request.input),
    ...persistedRest,
    revision,
    plans: store.plans.map((p) => (p.id === original.id ? changed : p)),
    decisions: [...store.decisions, decision],
    outcomes: [
      ...store.outcomes,
      {
        id: `outcome:${decision.id}`,
        decisionId: decision.id,
        status: "no_response",
        recordedAt: request.now,
      },
    ],
    revisions: [
      ...store.revisions,
      {
        id: `revision:${revision}`,
        number: revision,
        previousRevision: store.revision,
        inputVersion: request.input.inputVersion,
        ruleVersion: RULE_VERSION,
        createdAt: request.now,
        operationId: request.operationId,
        planId: original.id,
        candidates: structuredClone(fresh.candidates),
        rejected: structuredClone([...fresh.rejected, ...fresh.conditional]),
        acceptedDecisionId: decision.id,
        sourceIds: decision.sourceIds,
      },
    ],
  };
}
export const commitDecision = acceptRevision;

export function rejectPreview<T extends PlanStore>(
  store: T,
  planId: string,
  result: ReturnType<typeof repairPlan>,
  input?: RepairInput,
): T {
  if (result.inputVersion !== store.revision)
    throw new DomainError(
      "REVISION_CONFLICT",
      "Plan zmienił się. Przelicz podgląd ponownie.",
    );
  if (!result.conflicts.length && !input) return store;
  const revision = store.revision + 1;
  return {
    ...(input ? persistRepairContext(store, input) : store),
    revision,
    plans: store.plans.map((p) =>
      p.id === planId && result.conflicts.length
        ? {
            ...p,
            revision,
            status: "conflict",
            conflictReasons: structuredClone(result.conflicts),
          }
        : p,
    ),
  };
}

export function recordOutcome<T extends PlanStore>(
  store: T,
  outcome: Outcome,
): T {
  const decision = store.decisions.find((d) => d.id === outcome.decisionId);
  if (!decision)
    throw new DomainError("UNKNOWN_DECISION", "Nie znaleziono decyzji.");
  epoch(outcome.recordedAt);
  if (
    outcome.status !== "no_response" &&
    decision.kind !== "defer" &&
    epoch(outcome.recordedAt) <
      epoch(decision.candidate?.end ?? decision.originalPlan.end)
  )
    throw new DomainError(
      "OUTCOME_TOO_EARLY",
      "Rezultat możesz zapisać po zakończeniu zaplanowanego przedziału.",
    );
  if (
    !["done", "different", "not_done", "no_response"].includes(outcome.status)
  )
    throw new DomainError("INVALID_OUTCOME", "Nieprawidłowy rezultat.");
  for (const value of [outcome.energy, outcome.tension])
    if (
      value !== undefined &&
      (!Number.isFinite(value) || value < 0 || value > 10)
    )
      throw new DomainError(
        "INVALID_SELF_REPORT",
        "Samoocena mieści się w zakresie 0 do 10.",
      );
  return {
    ...store,
    outcomes: [
      ...store.outcomes.filter((o) => o.decisionId !== outcome.decisionId),
      structuredClone(outcome),
    ],
  };
}

export function correctSource<T extends DomainData>(
  data: T,
  sourceId: string,
  now: string,
): T {
  epoch(now);
  if (!data.sources.some((s) => s.id === sourceId && s.status !== "deleted"))
    throw new DomainError("UNKNOWN_SOURCE", "Nie znaleziono źródła.");
  const affectedPlanIds = new Set(
    data.decisions
      .filter((d) => d.sourceIds.includes(sourceId))
      .map((d) => d.planId),
  );
  const affectedVariants = new Set(
    data.activities.flatMap((a) =>
      a.variants.filter((v) => v.sourceId === sourceId).map((v) => v.id),
    ),
  );
  const contextAffected = [
    ...data.busy,
    ...data.availability,
    ...data.protectedWindows,
    ...data.constraints,
    ...data.resources,
  ].some((item) => item.sourceId === sourceId);
  return {
    ...data,
    revision: data.revision + 1,
    sources: data.sources.map((s) =>
      s.id === sourceId
        ? { ...s, revision: s.revision + 1, status: "corrected" as const }
        : s,
    ),
    plans: data.plans.map((p) =>
      epoch(p.start) >= epoch(now) &&
      (contextAffected ||
        affectedPlanIds.has(p.id) ||
        affectedVariants.has(p.variantId) ||
        p.sourceId === sourceId)
        ? { ...p, needsRevalidation: true, status: "conflict" as const }
        : p,
    ),
    carePackets: data.carePackets.map((p) =>
      p.sourceIds.includes(sourceId)
        ? { ...p, stale: true, approved: false }
        : p,
    ),
    exports: data.exports.map((e) =>
      e.sourceIds.includes(sourceId) ? { ...e, status: "stale" as const } : e,
    ),
  };
}

/** Remove source content from dependent snapshots too, retaining only a nonsensitive tombstone. Attachments are removed by the vault adapter. */
export function deleteSource<T extends DomainData>(
  data: T,
  sourceId: string,
  now: string,
): T {
  const next = correctSource(data, sourceId, now);
  const observationIds = new Set(
    data.observations.filter((o) => o.sourceId === sourceId).map((o) => o.id),
  );
  const factIds = new Set(
    data.documentFacts.filter((o) => o.sourceId === sourceId).map((o) => o.id),
  );
  const affectedDecisions = new Set(
    data.decisions
      .filter((d) => d.sourceIds.includes(sourceId))
      .map((d) => d.id),
  );
  const deletedContext = [
    ...data.busy,
    ...data.protectedWindows,
    ...data.constraints,
  ].some((item) => item.sourceId === sourceId);
  const tombstone: Source = {
    id: sourceId,
    kind: "manual",
    name: "Źródło usunięto",
    createdAt: now,
    status: "deleted",
    revision: (data.sources.find((s) => s.id === sourceId)?.revision ?? 0) + 1,
    aiAllowed: false,
    usageVerified: false,
  };
  return {
    ...next,
    sources: next.sources.map((s) => (s.id === sourceId ? tombstone : s)),
    observations: next.observations.filter((o) => o.sourceId !== sourceId),
    documentFacts: next.documentFacts.filter((o) => o.sourceId !== sourceId),
    availability: next.availability.filter((w) => w.sourceId !== sourceId),
    busy: next.busy.filter((w) => w.sourceId !== sourceId),
    protectedWindows: next.protectedWindows.filter(
      (w) => w.sourceId !== sourceId,
    ),
    resources: next.resources.map((r) =>
      r.sourceId === sourceId
        ? {
            id: r.id,
            label: "Zasób do ponownego potwierdzenia",
            status: "unknown" as const,
          }
        : r,
    ),
    activities: next.activities
      .map((a) => ({
        ...a,
        variants: a.variants.filter((v) => v.sourceId !== sourceId),
      }))
      .filter((a) => a.variants.length > 0),
    // Erasing the provenance of a restriction must not silently increase permitted movement.
    constraints: [
      ...next.constraints.filter((c) => c.sourceId !== sourceId),
      ...(deletedContext
        ? [
            {
              id: `deleted-source:${sourceId}`,
              kind: "unmapped" as const,
              mappingState: "needs_review" as const,
            },
          ]
        : []),
    ],
    plans: next.plans.map((p) =>
      p.sourceId === sourceId
        ? {
            ...p,
            sourceId: undefined,
            label: undefined,
            originalLocalStart: undefined,
            originalLocalEnd: undefined,
            needsRevalidation: true,
          }
        : p,
    ),
    decisions: next.decisions.map((d) =>
      affectedDecisions.has(d.id)
        ? {
            ...d,
            candidate: undefined,
            obstacle: undefined,
            sourceIds: d.sourceIds.filter((id) => id !== sourceId),
            sourceRemoved: true,
            originalPlan: {
              ...d.originalPlan,
              label: undefined,
              sourceId: undefined,
              originalLocalStart: undefined,
              originalLocalEnd: undefined,
            },
          }
        : d,
    ),
    outcomes: next.outcomes.map((o) =>
      affectedDecisions.has(o.decisionId) ? { ...o, note: undefined } : o,
    ),
    revisions: next.revisions.map((r) =>
      r.sourceIds.includes(sourceId)
        ? {
            ...r,
            candidates: [],
            rejected: [],
            sourceIds: r.sourceIds.filter((id) => id !== sourceId),
            sourceRemoved: true,
          }
        : r,
    ),
    carePackets: next.carePackets.map((p) =>
      p.sourceIds.includes(sourceId)
        ? {
            ...p,
            sourceIds: p.sourceIds.filter((id) => id !== sourceId),
            observationIds: p.observationIds.filter(
              (id) => !observationIds.has(id),
            ),
            documentFactIds: p.documentFactIds.filter((id) => !factIds.has(id)),
            goal: "",
            questions: [],
            stale: true,
            approved: false,
          }
        : p,
    ),
    exports: next.exports.map((e) =>
      e.sourceIds.includes(sourceId)
        ? {
            ...e,
            sourceIds: e.sourceIds.filter((id) => id !== sourceId),
            status: "stale" as const,
          }
        : e,
    ),
  };
}

export function summarizeHistory(data: DomainData, days: 7 | 28, now: string) {
  const end = DateTime.fromMillis(epoch(now), { zone: data.profile.timezone });
  const start = end.startOf("day").minus({ days: days - 1 });
  const rows = data.decisions
    .filter(
      (d) =>
        epoch(d.createdAt) >= start.toMillis() &&
        epoch(d.createdAt) <= end.toMillis(),
    )
    .sort((a, b) => epoch(b.createdAt) - epoch(a.createdAt))
    .map((decision) => ({
      decision,
      outcome: data.outcomes.find((o) => o.decisionId === decision.id),
    }));
  const status = (row: (typeof rows)[number]) =>
    row.outcome?.status ?? "no_response";
  const groups = new Map<
    string,
    {
      intentId: string;
      obstacle: string;
      variantId: string;
      chosen: number;
      done: number;
      noResponse: number;
      decisionIds: string[];
    }
  >();
  for (const row of rows) {
    const key = JSON.stringify([
      row.decision.intentId,
      row.decision.obstacle ?? "",
      row.decision.candidate?.variantId ?? row.decision.kind,
    ]);
    const group = groups.get(key) ?? {
      intentId: row.decision.intentId,
      obstacle: row.decision.obstacle ?? "",
      variantId: row.decision.candidate?.variantId ?? row.decision.kind,
      chosen: 0,
      done: 0,
      noResponse: 0,
      decisionIds: [],
    };
    group.chosen++;
    if (status(row) === "done") group.done++;
    if (status(row) === "no_response") group.noResponse++;
    group.decisionIds.push(row.decision.id);
    groups.set(key, group);
  }
  const coverage = data.sources
    .filter((source) => source.status !== "deleted")
    .flatMap((source) => {
      const observations = data.observations.filter(
        (o) =>
          o.sourceId === source.id &&
          o.status === "confirmed" &&
          epoch(o.start) <= end.toMillis() &&
          (epoch(o.end) > start.toMillis() ||
            (o.start === o.end && epoch(o.start) === start.toMillis())),
      );
      const metrics = [...new Set(observations.map((o) => o.metric))];
      if (!metrics.length) metrics.push("brak danych");
      return metrics.map((metric) => {
        const records = observations.filter((o) => o.metric === metric),
          dates = new Set<string>();
        for (
          let day = start;
          day.toMillis() <= end.toMillis();
          day = day.plus({ days: 1 })
        ) {
          const nextDay = day.plus({ days: 1 });
          if (
            records.some((o) =>
              observationIntersects(o, {
                start: day.toUTC().toISO()!,
                end: nextDay.toUTC().toISO()!,
              }),
            )
          )
            dates.add(day.toISODate()!);
        }
        const overlapIds = records
          .filter((a) =>
            data.observations.some(
              (b) =>
                b.id !== a.id &&
                b.sourceId !== a.sourceId &&
                b.metric === a.metric &&
                b.status === "confirmed" &&
                observationIntersects(a, b),
            ),
          )
          .map((a) => a.id);
        return {
          sourceId: source.id,
          sourceName: source.name,
          metric,
          coveredDays: dates.size,
          totalDays: days,
          records: records.length,
          dates: [...dates],
          overlapIds,
        };
      });
    });
  return {
    start: start.toUTC().toISO()!,
    end: end.toUTC().toISO()!,
    days,
    rows,
    counts: {
      decisions: rows.length,
      done: rows.filter((r) => status(r) === "done").length,
      different: rows.filter((r) => status(r) === "different").length,
      notDone: rows.filter((r) => status(r) === "not_done").length,
      noResponse: rows.filter((r) => status(r) === "no_response").length,
      rest: rows.filter((r) => r.decision.kind === "rest").length,
      deferred: rows.filter((r) => r.decision.kind === "defer").length,
    },
    similar: [...groups.values()],
    coverage,
    similarityDefinition:
      "Ten sam zapisany cel, identyczna przeszkoda i wybrany wariant. Opis własnych obserwacji, bez wnioskowania o przyczynach i prawdopodobieństwie sukcesu.",
  };
}

export interface CareSelection {
  id?: string;
  start: string;
  end: string;
  goal: string;
  questions: string[];
  observationIds: string[];
  documentFactIds: string[];
  decisionIds: string[];
  now?: string;
  approved?: boolean;
}
function observationIntersects(
  a: { start: string; end: string },
  b: { start: string; end: string },
): boolean {
  const as = epoch(a.start),
    ae = epoch(a.end),
    bs = epoch(b.start),
    be = epoch(b.end);
  if (as === ae && bs === be) return as === bs;
  if (as === ae) return as >= bs && as < be;
  if (bs === be) return bs >= as && bs < ae;
  return overlaps(a, b);
}
export function buildCarePacket(
  data: DomainData,
  selection: CareSelection,
): CarePacket {
  if (epoch(selection.end) <= epoch(selection.start))
    throw new DomainError("INVALID_PERIOD", "Sprawdź okres raportu.");
  const sourceIds = new Set<string>();
  for (const id of selection.observationIds) {
    const observation = data.observations.find((o) => o.id === id);
    if (
      !observation ||
      observation.status !== "confirmed" ||
      !observationIntersects(observation, selection)
    )
      throw new DomainError(
        "UNCONFIRMED_FACT",
        "Raport może zawierać potwierdzone obserwacje z wybranego okresu.",
      );
    sourceIds.add(observation.sourceId);
  }
  for (const id of selection.documentFactIds) {
    const fact = data.documentFacts.find((f) => f.id === id);
    if (!fact || fact.status !== "confirmed")
      throw new DomainError(
        "UNCONFIRMED_FACT",
        "Potwierdź fragment dokumentu przed dodaniem do raportu.",
      );
    sourceIds.add(fact.sourceId);
  }
  for (const id of selection.decisionIds) {
    const decision = data.decisions.find((d) => d.id === id);
    if (
      !decision ||
      epoch(decision.createdAt) < epoch(selection.start) ||
      epoch(decision.createdAt) >= epoch(selection.end)
    )
      throw new DomainError(
        "UNKNOWN_DECISION",
        "Decyzja nie należy do wybranego okresu.",
      );
    decision.sourceIds.forEach((sourceId) => sourceIds.add(sourceId));
  }
  for (const id of sourceIds)
    if (!data.sources.some((s) => s.id === id && s.status !== "deleted"))
      throw new DomainError(
        "UNKNOWN_SOURCE",
        "Wybrany fakt ma usunięte lub nieznane źródło.",
      );
  const createdAt = selection.now ?? selection.end;
  return {
    id: selection.id ?? `care:${createdAt}`,
    version: 1,
    createdAt,
    start: selection.start,
    end: selection.end,
    goal: selection.goal,
    questions: [...selection.questions],
    sourceIds: [...sourceIds],
    observationIds: [...new Set(selection.observationIds)],
    documentFactIds: [...new Set(selection.documentFactIds)],
    decisionIds: [...new Set(selection.decisionIds)],
    approved: selection.approved ?? false,
    stale: false,
    synthetic: data.profile.mode === "demo",
  };
}
