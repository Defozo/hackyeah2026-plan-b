export type ISODateTime = string;
export type Priority =
  "activity" | "duration" | "time" | "location" | "companionship";
export type ConfirmationStatus = "pending" | "confirmed" | "rejected";
export interface Interval {
  id: string;
  start: ISODateTime;
  end: ISODateTime;
  timezone?: string;
  originalLocalStart?: string;
  originalLocalEnd?: string;
  sourceId?: string;
  kind?: "work" | "rest" | "buffer" | "activity" | "available";
  label?: string;
}
export interface Profile {
  id: string;
  timezone: string;
  priorities: Priority[];
  mode: "demo" | "personal";
}
export interface Intent {
  id: string;
  label: string;
}
export interface ActivityVariant {
  id: string;
  templateId: string;
  name: string;
  activityType: string;
  intentIds: string[];
  durationMinutes: number;
  preparationMinutes: number;
  travelMinutes: number | null;
  travelOptionsMinutes?: number[];
  locationId: string;
  resourceIds: string[];
  companionship?: string;
  confirmed: boolean;
  sourceId?: string;
  preferredStartMinutes?: number[];
  preferenceRank?: number;
}
export interface ActivityTemplate {
  id: string;
  name: string;
  variants: ActivityVariant[];
}
export interface PlannedActivity extends Interval {
  variantId: string;
  intentId: string;
  status: "accepted" | "conflict" | "rest" | "deferred";
  revision: number;
  needsRevalidation?: boolean;
  conflictReasons?: RuleEvidence[];
}
export interface Resource {
  id: string;
  label: string;
  status: "available" | "unavailable" | "unknown";
  windows?: Interval[];
  sourceId?: string;
}
export interface Constraint {
  id: string;
  kind:
    "exclude" | "max_duration" | "requires_resource" | "available" | "unmapped";
  sourceId?: string;
  sourceText?: string;
  consultationDate?: string;
  mappingState: "confirmed" | "pending" | "needs_review";
  activityTypes?: string[];
  variantIds?: string[];
  maxDurationMinutes?: number;
  resourceIds?: string[];
  windows?: Interval[];
  validFrom?: ISODateTime;
  validUntil?: ISODateTime;
}
export type ReasonCode =
  | "WORK_CONFLICT"
  | "PROTECTED_REST"
  | "BUFFER_CONFLICT"
  | "ACCEPTED_PLAN_CONFLICT"
  | "OUTSIDE_AVAILABILITY"
  | "INSUFFICIENT_TIME"
  | "MISSING_TRAVEL_TIME"
  | "RESOURCE_UNKNOWN"
  | "RESOURCE_UNAVAILABLE"
  | "INTENT_CHANGED"
  | "INTENT_PRESERVED"
  | "UNCONFIRMED_VARIANT"
  | "ACTIVITY_EXCLUDED"
  | "MAX_DURATION"
  | "CONSTRAINT_REVIEW_REQUIRED"
  | "REST_TODAY"
  | "PAST_PLAN"
  | "INVALID_INPUT"
  | "TIME_CHANGED"
  | "DURATION_CHANGED"
  | "LOCATION_CHANGED"
  | "ACTIVITY_CHANGED"
  | "COMPANIONSHIP_CHANGED"
  | "SOURCE_REVALIDATION_REQUIRED";
export interface RuleEvidence {
  code: ReasonCode;
  evidenceIds: string[];
  message: string;
}
export interface Candidate {
  id: string;
  variantId: string;
  templateId: string;
  name: string;
  start: ISODateTime;
  end: ISODateTime;
  timezone: string;
  originalLocalStart: string;
  originalLocalEnd: string;
  totalMinutes: number;
  durationMinutes: number;
  preparationMinutes: number;
  travelMinutes: number;
  intentPreserved: boolean;
  intentId: string;
  locationId: string;
  changes: {
    activity: boolean;
    duration: boolean;
    time: boolean;
    location: boolean;
    companionship: boolean;
    count: number;
    startShiftMinutes: number;
    durationDeltaMinutes: number;
  };
  reasonCodes: ReasonCode[];
  evidenceIds: string[];
  reasons: RuleEvidence[];
  rank: number[];
  sourceIds: string[];
}
export interface CandidateDiagnostic {
  variantId: string;
  start?: ISODateTime;
  end?: ISODateTime;
  reasonCodes: ReasonCode[];
  evidenceIds: string[];
  reasons: RuleEvidence[];
  unknownIds: string[];
}
export interface RepairQuestion {
  id: string;
  kind: "resource" | "travel";
  subjectId: string;
  text: string;
  options: { value: boolean | number; label: string }[];
  affectedVariantIds: string[];
}
export interface RepairInput {
  now: ISODateTime;
  timezone: string;
  intent: Intent;
  plan: PlannedActivity;
  activities: ActivityTemplate[];
  availability: Interval[];
  busy: Interval[];
  protectedWindows: Interval[];
  acceptedPlans?: PlannedActivity[];
  constraints: Constraint[];
  resources: Resource[];
  priorities: Priority[];
  answers?: Record<string, boolean | number | "skip">;
  allowIntentChange?: boolean;
  restToday?: boolean;
  history?: Decision[];
  inputVersion: number;
  preferredStartMinutes?: number[];
}
export interface RepairResult {
  ruleVersion: string;
  inputVersion: number;
  candidates: Candidate[];
  conditional: CandidateDiagnostic[];
  rejected: CandidateDiagnostic[];
  conflicts: RuleEvidence[];
  question?: RepairQuestion;
  freeWindows: Interval[];
  alwaysAvailable: readonly ["rest", "defer"];
  status: "options" | "needs_information" | "no_confirmed_option";
}
export interface Decision {
  id: string;
  operationId: string;
  planId: string;
  revision: number;
  createdAt: ISODateTime;
  kind: "activity" | "rest" | "defer";
  candidate?: Candidate;
  intentId: string;
  obstacle?: string;
  originalPlan: PlannedActivity;
  sourceIds: string[];
  sourceRemoved?: boolean;
}
export interface Outcome {
  id: string;
  decisionId: string;
  status: "done" | "different" | "not_done" | "no_response";
  recordedAt: ISODateTime;
  note?: string;
  energy?: number;
  tension?: number;
}
export interface PlanRevision {
  id: string;
  number: number;
  previousRevision: number;
  inputVersion: number;
  ruleVersion: string;
  createdAt: ISODateTime;
  operationId: string;
  planId: string;
  candidates: Candidate[];
  rejected: CandidateDiagnostic[];
  acceptedDecisionId: string;
  sourceIds: string[];
  sourceRemoved?: boolean;
}
export interface PlanStore {
  revision: number;
  plans: PlannedActivity[];
  revisions: PlanRevision[];
  decisions: Decision[];
  outcomes: Outcome[];
}
export interface AcceptRevisionRequest {
  operationId: string;
  expectedRevision: number;
  input: RepairInput;
  result: RepairResult;
  choice:
    { kind: "activity"; candidateId: string } | { kind: "rest" | "defer" };
  now: ISODateTime;
  obstacle?: string;
}
export interface Source {
  id: string;
  kind: "manual" | "ics" | "csv" | "fit" | "pdf" | "image" | "voice";
  name: string;
  createdAt: ISODateTime;
  hash?: string;
  parserVersion?: string;
  status: "active" | "corrected" | "deleted";
  revision: number;
  aiAllowed: boolean;
  usageVerified: boolean;
  synthetic?: boolean;
}
export interface Observation extends Interval {
  sourceId: string;
  externalId?: string;
  metric: string;
  value: number | string | null;
  unit: string;
  status: ConfirmationStatus;
  quality?: string;
  revision: number;
  supersedesId?: string;
}
export interface DocumentFact {
  id: string;
  sourceId: string;
  page: number;
  label: string;
  value: string;
  unit?: string;
  status: ConfirmationStatus;
  revision: number;
  correctedFrom?: string;
}
export interface CarePacket {
  id: string;
  version: number;
  createdAt: ISODateTime;
  start: ISODateTime;
  end: ISODateTime;
  goal: string;
  questions: string[];
  sourceIds: string[];
  observationIds: string[];
  documentFactIds: string[];
  decisionIds: string[];
  approved: boolean;
  stale: boolean;
  synthetic: boolean;
}
export interface ConsentRecord {
  id: string;
  provider: string;
  purpose: "text" | "audio";
  scope: string[];
  grantedAt: ISODateTime;
  revokedAt?: ISODateTime;
}
export interface ExportRecord {
  id: string;
  kind: "ics" | "html" | "pdf" | "csv" | "backup";
  createdAt: ISODateTime;
  sourceIds: string[];
  status: "downloaded" | "stale";
}
export interface DomainData extends PlanStore {
  profile: Profile;
  intents: Intent[];
  activities: ActivityTemplate[];
  availability: Interval[];
  busy: Interval[];
  protectedWindows: Interval[];
  constraints: Constraint[];
  resources: Resource[];
  sources: Source[];
  observations: Observation[];
  documentFacts: DocumentFact[];
  carePackets: CarePacket[];
  consents: ConsentRecord[];
  exports: ExportRecord[];
}
