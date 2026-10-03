import { DateTime } from "luxon";
import { repairPlan } from "./engine";
import type { DomainData, RepairInput } from "./types";

export function createEmptyData(timezone = "Europe/Warsaw"): DomainData {
  return {
    revision: 0,
    profile: {
      id: "local-profile",
      timezone,
      priorities: ["time", "duration"],
      mode: "personal",
    },
    intents: [
      { id: "screen-break", label: "Ruch poza ekranem" },
      { id: "specific-training", label: "Mój konkretny trening" },
      { id: "social", label: "Spotkanie z innymi" },
    ],
    activities: [],
    availability: [],
    busy: [],
    protectedWindows: [],
    constraints: [],
    resources: [],
    plans: [],
    revisions: [],
    decisions: [],
    outcomes: [],
    sources: [],
    observations: [],
    documentFacts: [],
    carePackets: [],
    consents: [],
    exports: [],
  };
}

/** Synthetic fixtures are anchored to the supplied clock, and never imply a longitudinal study. */
export function createDemoData(now = new Date().toISOString()): DomainData {
  const data = createEmptyData(),
    zone = data.profile.timezone;
  const anchor = DateTime.fromISO(now, { zone })
    .plus({ minutes: 30 })
    .startOf("minute");
  const at = (value: DateTime): string => value.toUTC().toISO()!;
  data.profile = { ...data.profile, id: "synthetic-profile", mode: "demo" };
  data.sources = [
    {
      id: "source-manual",
      kind: "manual",
      name: "Własne wpisy (dane syntetyczne)",
      createdAt: now,
      status: "active",
      revision: 1,
      aiAllowed: true,
      usageVerified: true,
      synthetic: true,
    },
    {
      id: "source-document",
      kind: "pdf",
      name: "Syntetyczna notatka przed konsultacją",
      createdAt: now,
      status: "active",
      revision: 1,
      aiAllowed: true,
      usageVerified: true,
      synthetic: true,
    },
    {
      id: "source-sleep",
      kind: "csv",
      name: "Przykładowy dziennik snu",
      createdAt: now,
      status: "active",
      revision: 1,
      aiAllowed: true,
      usageVerified: true,
      synthetic: true,
    },
  ];
  data.resources = [
    { id: "gym", label: "Moja sala treningowa", status: "available" },
    { id: "home", label: "Okolica domu", status: "available" },
    { id: "mat", label: "Mata", status: "available" },
  ];
  data.activities = [
    {
      id: "training",
      name: "Mój trening",
      variants: [
        {
          id: "training-30",
          templateId: "training",
          name: "Mój trening na sali",
          activityType: "training",
          intentIds: ["screen-break", "specific-training"],
          durationMinutes: 30,
          preparationMinutes: 0,
          travelMinutes: 20,
          locationId: "gym",
          resourceIds: ["mat"],
          confirmed: true,
          sourceId: "source-manual",
        },
        {
          id: "training-home",
          templateId: "training",
          name: "Znany trening w domu",
          activityType: "training",
          intentIds: ["screen-break", "specific-training"],
          durationMinutes: 15,
          preparationMinutes: 5,
          travelMinutes: 0,
          locationId: "home",
          resourceIds: ["mat"],
          confirmed: true,
          sourceId: "source-manual",
          preferenceRank: 1,
        },
      ],
    },
    {
      id: "walk",
      name: "Spacer",
      variants: [
        {
          id: "walk-15",
          templateId: "walk",
          name: "Spacer przy domu",
          activityType: "walking",
          intentIds: ["screen-break"],
          durationMinutes: 15,
          preparationMinutes: 5,
          travelMinutes: 0,
          locationId: "home",
          resourceIds: [],
          confirmed: true,
          sourceId: "source-manual",
        },
      ],
    },
  ];
  data.plans = [
    {
      id: "plan-main",
      start: at(anchor),
      end: at(anchor.plus({ minutes: 50 })),
      timezone: zone,
      originalLocalStart: anchor.toISO()!,
      originalLocalEnd: anchor.plus({ minutes: 50 }).toISO()!,
      label: "Mój trening",
      kind: "activity",
      variantId: "training-30",
      intentId: "screen-break",
      status: "accepted",
      revision: 0,
      sourceId: "source-manual",
    },
  ];
  data.availability = [
    {
      id: "available-today",
      start: at(anchor),
      end: at(anchor.plus({ minutes: 20 })),
      timezone: zone,
      kind: "available",
    },
  ];
  data.busy = [
    {
      id: "extra-shift",
      start: at(anchor.plus({ minutes: 20 })),
      end: at(anchor.plus({ minutes: 140 })),
      timezone: zone,
      kind: "work",
      label: "Dodatkowa zmiana",
    },
  ];
  for (let day = 1; day < 7; day++) {
    const start = anchor.plus({ days: day }).set({ hour: 17, minute: 0 });
    data.availability.push({
      id: `available-${day}`,
      start: at(start),
      end: at(start.plus({ hours: 3 })),
      timezone: zone,
      kind: "available",
    });
    const rest = start.set({ hour: 22 });
    data.protectedWindows.push({
      id: `rest-${day}`,
      start: at(rest),
      end: at(rest.plus({ hours: 8 })),
      timezone: zone,
      kind: "rest",
      label: "Chroniony odpoczynek",
    });
  }
  const nightShift = anchor.plus({ days: 2 }).set({ hour: 22, minute: 0 });
  data.busy.push({
    id: "night-shift",
    start: at(nightShift),
    end: at(nightShift.plus({ hours: 8 })),
    timezone: zone,
    kind: "work",
    label: "Zmiana nocna",
  });
  data.protectedWindows = data.protectedWindows.filter(
    (w) => w.id !== "rest-2",
  );
  data.protectedWindows.push({
    id: "after-night",
    start: at(nightShift.plus({ hours: 8 })),
    end: at(nightShift.plus({ hours: 15 })),
    timezone: zone,
    kind: "rest",
    label: "Odpoczynek po nocnej zmianie",
  });
  const other = anchor.plus({ days: 1 }).set({ hour: 19, minute: 0 });
  data.plans.push({
    id: "plan-other",
    start: at(other),
    end: at(other.plus({ minutes: 20 })),
    timezone: zone,
    variantId: "walk-15",
    intentId: "screen-break",
    status: "accepted",
    revision: 0,
    label: "Zaakceptowany spacer",
  });
  data.documentFacts = [
    {
      id: "fact-confirmed",
      sourceId: "source-document",
      page: 1,
      label: "Cel rozmowy (samoopis)",
      value: "Chcę omówić organizację ruchu przy nieregularnych zmianach.",
      status: "confirmed",
      revision: 1,
    },
    {
      id: "fact-pending",
      sourceId: "source-document",
      page: 1,
      label: "Fragment do sprawdzenia",
      value: "Nieczytelny fragment wymaga potwierdzenia.",
      status: "pending",
      revision: 1,
    },
  ];
  for (const day of [1, 2, 4, 6]) {
    const start = anchor.minus({ days: day }).startOf("day");
    data.observations.push({
      id: `sleep-${day}`,
      sourceId: "source-sleep",
      metric: "sleep_duration",
      value: 6 + day / 10,
      unit: "h",
      start: at(start),
      end: at(start.plus({ hours: 7 })),
      timezone: zone,
      status: "confirmed",
      revision: 1,
    });
  }
  for (let index = 1; index <= 3; index++) {
    const created = at(anchor.minus({ days: index, hours: 1 }));
    const input = createRepairInput(data, data.plans[0]!.id, now);
    const historical = repairPlan(input).candidates.find(
      (c) => c.variantId === "walk-15",
    );
    const historicalStart = anchor.minus({ days: index }),
      historicalEnd = historicalStart.plus({ minutes: 20 });
    const candidate = historical
      ? {
          ...historical,
          id: `walk-15@${at(historicalStart)}`,
          start: at(historicalStart),
          end: at(historicalEnd),
          originalLocalStart: historicalStart.toISO()!,
          originalLocalEnd: historicalEnd.toISO()!,
        }
      : undefined;
    data.decisions.push({
      id: `demo-decision-${index}`,
      operationId: `demo-operation-${index}`,
      planId: `demo-past-${index}`,
      revision: 0,
      createdAt: created,
      kind: "activity",
      candidate,
      intentId: "screen-break",
      obstacle: "Mniej czasu",
      originalPlan: {
        ...data.plans[0]!,
        id: `demo-past-${index}`,
        start: at(anchor.minus({ days: index })),
        end: at(anchor.minus({ days: index }).plus({ minutes: 50 })),
      },
      sourceIds: ["source-manual"],
    });
    data.outcomes.push({
      id: `demo-outcome-${index}`,
      decisionId: `demo-decision-${index}`,
      status: index === 3 ? "no_response" : "done",
      recordedAt:
        index === 3 ? created : at(historicalEnd.plus({ minutes: 5 })),
    });
  }
  return data;
}

export function createRepairInput(
  data: DomainData,
  planId: string,
  now: string,
): RepairInput {
  const plan = data.plans.find((p) => p.id === planId);
  if (!plan) throw new Error("Nie znaleziono planu.");
  const intent = data.intents.find((i) => i.id === plan.intentId);
  if (!intent) throw new Error("Nie znaleziono celu.");
  return {
    now,
    timezone: data.profile.timezone,
    intent,
    plan,
    activities: data.activities,
    availability: data.availability,
    busy: data.busy,
    protectedWindows: data.protectedWindows,
    acceptedPlans: data.plans,
    constraints: data.constraints,
    resources: data.resources,
    priorities: data.profile.priorities,
    history: data.decisions,
    inputVersion: data.revision,
  };
}
