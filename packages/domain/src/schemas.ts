import { z } from "zod";
import { DateTime, IANAZone } from "luxon";

export const isoDateTimeSchema = z
  .string()
  .refine(
    (value) =>
      /(Z|[+-]\d{2}:\d{2})$/.test(value) &&
      DateTime.fromISO(value, { setZone: true }).isValid,
    "Nieprawidłowa data lub brak offsetu.",
  );
export const timezoneSchema = z
  .string()
  .refine(
    (value) => value === "UTC" || IANAZone.isValidZone(value),
    "Nieznana strefa.",
  );
const id = z.string().min(1).max(500),
  text = z.string().max(100000),
  ids = z.array(id).max(100000);
const version = z.number().int().nonnegative(),
  minutes = z.number().finite().min(0).max(10080);
export const confirmationSchema = z.enum(["pending", "confirmed", "rejected"]);
export const prioritySchema = z.enum([
  "activity",
  "duration",
  "time",
  "location",
  "companionship",
]);
export const intervalSchema = z
  .object({
    id,
    start: isoDateTimeSchema,
    end: isoDateTimeSchema,
    timezone: timezoneSchema.optional(),
    originalLocalStart: text.optional(),
    originalLocalEnd: text.optional(),
    sourceId: id.optional(),
    kind: z
      .enum(["work", "rest", "buffer", "activity", "available"])
      .optional(),
    label: text.optional(),
  })
  .refine(
    (v) => Date.parse(v.end) > Date.parse(v.start),
    "Przedział musi mieć dodatnią długość.",
  );
export const profileSchema = z.object({
  id,
  timezone: timezoneSchema,
  priorities: z.array(prioritySchema).max(5),
  mode: z.enum(["demo", "personal"]),
});
export const intentSchema = z.object({ id, label: text });
export const activityVariantSchema = z.object({
  id,
  templateId: id,
  name: text,
  activityType: id,
  intentIds: ids.min(1),
  durationMinutes: minutes.positive(),
  preparationMinutes: minutes,
  travelMinutes: minutes.nullable(),
  travelOptionsMinutes: z.array(minutes).max(12).optional(),
  locationId: id,
  resourceIds: ids,
  companionship: text.optional(),
  confirmed: z.boolean(),
  sourceId: id.optional(),
  preferredStartMinutes: z
    .array(z.number().int().min(0).max(1439))
    .max(24)
    .optional(),
  preferenceRank: z.number().finite().optional(),
});
export const activityTemplateSchema = z.object({
  id,
  name: text,
  variants: z.array(activityVariantSchema).max(1000),
});
export const resourceSchema = z.object({
  id,
  label: text,
  status: z.enum(["available", "unavailable", "unknown"]),
  windows: z.array(intervalSchema).optional(),
  sourceId: id.optional(),
});
export const constraintSchema = z
  .object({
    id,
    kind: z.enum([
      "exclude",
      "max_duration",
      "requires_resource",
      "available",
      "unmapped",
    ]),
    sourceId: id.optional(),
    sourceText: text.optional(),
    consultationDate: text.optional(),
    mappingState: z.enum(["confirmed", "pending", "needs_review"]),
    activityTypes: ids.optional(),
    variantIds: ids.optional(),
    maxDurationMinutes: minutes.optional(),
    resourceIds: ids.optional(),
    windows: z.array(intervalSchema).optional(),
    validFrom: isoDateTimeSchema.optional(),
    validUntil: isoDateTimeSchema.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "max_duration" && v.maxDurationMinutes === undefined)
      ctx.addIssue({ code: "custom", message: "Brak maksymalnego czasu." });
    if (v.kind === "requires_resource" && !v.resourceIds?.length)
      ctx.addIssue({ code: "custom", message: "Brak zasobu." });
    if (v.kind === "available" && !v.windows?.length)
      ctx.addIssue({ code: "custom", message: "Brak przedziału." });
    if (
      v.validFrom &&
      v.validUntil &&
      Date.parse(v.validFrom) >= Date.parse(v.validUntil)
    )
      ctx.addIssue({ code: "custom", message: "Błędny okres ograniczenia." });
  });
export const plannedActivitySchema = intervalSchema.safeExtend({
  variantId: id,
  intentId: id,
  status: z.enum(["accepted", "conflict", "rest", "deferred"]),
  revision: version,
  needsRevalidation: z.boolean().optional(),
  conflictReasons: z.lazy(() => z.array(ruleEvidenceSchema)).optional(),
});
export const reasonCodeSchema = z.enum([
  "WORK_CONFLICT",
  "PROTECTED_REST",
  "BUFFER_CONFLICT",
  "ACCEPTED_PLAN_CONFLICT",
  "OUTSIDE_AVAILABILITY",
  "INSUFFICIENT_TIME",
  "MISSING_TRAVEL_TIME",
  "RESOURCE_UNKNOWN",
  "RESOURCE_UNAVAILABLE",
  "INTENT_CHANGED",
  "INTENT_PRESERVED",
  "UNCONFIRMED_VARIANT",
  "ACTIVITY_EXCLUDED",
  "MAX_DURATION",
  "CONSTRAINT_REVIEW_REQUIRED",
  "REST_TODAY",
  "PAST_PLAN",
  "INVALID_INPUT",
  "TIME_CHANGED",
  "DURATION_CHANGED",
  "LOCATION_CHANGED",
  "ACTIVITY_CHANGED",
  "COMPANIONSHIP_CHANGED",
  "SOURCE_REVALIDATION_REQUIRED",
]);
export const ruleEvidenceSchema = z.object({
  code: reasonCodeSchema,
  evidenceIds: ids,
  message: text,
});
export const candidateSchema = z.object({
  id,
  variantId: id,
  templateId: id,
  name: text,
  start: isoDateTimeSchema,
  end: isoDateTimeSchema,
  timezone: timezoneSchema,
  originalLocalStart: text,
  originalLocalEnd: text,
  totalMinutes: minutes.positive(),
  durationMinutes: minutes.positive(),
  preparationMinutes: minutes,
  travelMinutes: minutes,
  intentPreserved: z.boolean(),
  intentId: id,
  locationId: id,
  changes: z.object({
    activity: z.boolean(),
    duration: z.boolean(),
    time: z.boolean(),
    location: z.boolean(),
    companionship: z.boolean(),
    count: z.number().int().min(0).max(5),
    startShiftMinutes: z.number().finite(),
    durationDeltaMinutes: z.number().finite(),
  }),
  reasonCodes: z.array(reasonCodeSchema),
  evidenceIds: ids,
  reasons: z.array(ruleEvidenceSchema),
  rank: z.array(z.number().finite()),
  sourceIds: ids,
});
export const candidateDiagnosticSchema = z.object({
  variantId: id,
  start: isoDateTimeSchema.optional(),
  end: isoDateTimeSchema.optional(),
  reasonCodes: z.array(reasonCodeSchema),
  evidenceIds: ids,
  reasons: z.array(ruleEvidenceSchema),
  unknownIds: ids,
});
export const decisionSchema = z.object({
  id,
  operationId: id,
  planId: id,
  revision: version,
  createdAt: isoDateTimeSchema,
  kind: z.enum(["activity", "rest", "defer"]),
  candidate: candidateSchema.optional(),
  intentId: id,
  obstacle: text.optional(),
  originalPlan: plannedActivitySchema,
  sourceIds: ids,
  sourceRemoved: z.boolean().optional(),
});
export const outcomeSchema = z.object({
  id,
  decisionId: id,
  status: z.enum(["done", "different", "not_done", "no_response"]),
  recordedAt: isoDateTimeSchema,
  note: text.optional(),
  energy: z.number().min(0).max(10).optional(),
  tension: z.number().min(0).max(10).optional(),
});
export const planRevisionSchema = z.object({
  id,
  number: version,
  previousRevision: version,
  inputVersion: version,
  ruleVersion: id,
  createdAt: isoDateTimeSchema,
  operationId: id,
  planId: id,
  candidates: z.array(candidateSchema),
  rejected: z.array(candidateDiagnosticSchema),
  acceptedDecisionId: id,
  sourceIds: ids,
  sourceRemoved: z.boolean().optional(),
});
export const sourceSchema = z.object({
  id,
  kind: z.enum(["manual", "ics", "csv", "fit", "pdf", "image", "voice"]),
  name: text,
  createdAt: isoDateTimeSchema,
  hash: text.optional(),
  parserVersion: text.optional(),
  status: z.enum(["active", "corrected", "deleted"]),
  revision: version,
  aiAllowed: z.boolean(),
  usageVerified: z.boolean(),
  synthetic: z.boolean().optional(),
});
export const observationSchema = z
  .object(intervalSchema.shape)
  .extend({
    sourceId: id,
    externalId: text.optional(),
    metric: id,
    value: z.union([z.number().finite(), text, z.null()]),
    unit: text,
    status: confirmationSchema,
    quality: text.optional(),
    revision: version,
    supersedesId: id.optional(),
  })
  .refine(
    (v) => Date.parse(v.end) >= Date.parse(v.start),
    "Koniec obserwacji nie może poprzedzać początku.",
  );
export const documentFactSchema = z.object({
  id,
  sourceId: id,
  page: z.number().int().positive(),
  label: text,
  value: text,
  unit: text.optional(),
  status: confirmationSchema,
  revision: version,
  correctedFrom: text.optional(),
});
export const carePacketSchema = z.object({
  id,
  version,
  createdAt: isoDateTimeSchema,
  start: isoDateTimeSchema,
  end: isoDateTimeSchema,
  goal: text,
  questions: z.array(text),
  sourceIds: ids,
  observationIds: ids,
  documentFactIds: ids,
  decisionIds: ids,
  approved: z.boolean(),
  stale: z.boolean(),
  synthetic: z.boolean(),
});
export const consentRecordSchema = z.object({
  id,
  provider: id,
  purpose: z.enum(["text", "audio"]),
  scope: ids,
  grantedAt: isoDateTimeSchema,
  revokedAt: isoDateTimeSchema.optional(),
});
export const exportRecordSchema = z.object({
  id,
  kind: z.enum(["ics", "html", "pdf", "csv", "backup"]),
  createdAt: isoDateTimeSchema,
  sourceIds: ids,
  status: z.enum(["downloaded", "stale"]),
});
export const domainDataSchema = z.object({
  profile: profileSchema,
  revision: version,
  intents: z.array(intentSchema),
  activities: z.array(activityTemplateSchema),
  availability: z.array(intervalSchema),
  busy: z.array(intervalSchema),
  protectedWindows: z.array(intervalSchema),
  constraints: z.array(constraintSchema),
  resources: z.array(resourceSchema),
  plans: z.array(plannedActivitySchema),
  revisions: z.array(planRevisionSchema),
  decisions: z.array(decisionSchema),
  outcomes: z.array(outcomeSchema),
  sources: z.array(sourceSchema),
  observations: z.array(observationSchema),
  documentFacts: z.array(documentFactSchema),
  carePackets: z.array(carePacketSchema),
  consents: z.array(consentRecordSchema),
  exports: z.array(exportRecordSchema),
});
export const repairInputSchema = z.object({
  now: isoDateTimeSchema,
  timezone: timezoneSchema,
  intent: intentSchema,
  plan: plannedActivitySchema,
  activities: z.array(activityTemplateSchema),
  availability: z.array(intervalSchema),
  busy: z.array(intervalSchema),
  protectedWindows: z.array(intervalSchema),
  acceptedPlans: z.array(plannedActivitySchema).optional(),
  constraints: z.array(constraintSchema),
  resources: z.array(resourceSchema),
  priorities: z.array(prioritySchema).max(5),
  answers: z
    .record(
      z.string(),
      z.union([z.boolean(), z.number().finite(), z.literal("skip")]),
    )
    .optional(),
  allowIntentChange: z.boolean().optional(),
  restToday: z.boolean().optional(),
  history: z.array(decisionSchema).optional(),
  inputVersion: version,
  preferredStartMinutes: z.array(z.number().int().min(0).max(1439)).optional(),
});
