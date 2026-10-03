export type ImportStatus =
  "preview" | "needs_review" | "confirmed" | "cancelled" | "failed";
export type FactStatus = "pending" | "confirmed" | "rejected";
export type ImportKind = "ics" | "csv" | "fit" | "pdf" | "image";
export interface ImportSource {
  id: string;
  name: string;
  type: ImportKind;
  hash: string;
  parser: string;
  allowedUse: "local_only";
  importedAt: string;
}
export interface ImportIssue {
  code: string;
  message: string;
  severity: "warning" | "error";
  row?: number;
  recordId?: string;
}
export interface CalendarRecord {
  id: string;
  sourceId: string;
  externalId: string;
  uid: string;
  recurrenceId?: string;
  version: number;
  start: string;
  end: string;
  timezone: string;
  originalLocal: string;
  originalEndLocal: string;
  allDay: boolean;
  kind: "work" | "rest" | "busy";
  label: string;
}
export interface CalendarCancellation {
  uid: string;
  recurrenceId?: string;
  version: number;
  sourceId: string;
}
export interface CalendarSeries {
  uid: string;
  version: number;
  sourceId: string;
}
export interface ObservationRecord {
  id: string;
  sourceId: string;
  sourceName: string;
  externalId: string;
  version: number;
  /** External file version, independent from the user's local correction revision. */
  sourceVersion?: number;
  metric: string;
  start: string;
  end: string;
  timezone: string;
  originalLocal: string;
  value: number;
  unit: string;
  originalValue: string;
  originalUnit: string;
  status: FactStatus;
  activityType?: string;
  primary?: boolean;
}
export interface DocumentFact {
  id: string;
  sourceId: string;
  page: number;
  label: string;
  text: string;
  value?: number;
  unit?: string;
  referenceRange?: string;
  date?: string;
  status: FactStatus;
  confidence?: number;
  extraction: "text" | "ocr";
  version: number;
  originalText: string;
}
export interface DocumentPage {
  page: number;
  sourceId: string;
  text: string;
  extraction: "text" | "ocr";
  confidence?: number;
  image?: Uint8Array;
  imageType?: string;
}
export interface ImportAttachment {
  id: string;
  sourceId: string;
  name: string;
  mimeType: string;
  data: Uint8Array;
}
export interface ImportPreview {
  id: string;
  status: ImportStatus;
  source: ImportSource;
  calendar: CalendarRecord[];
  cancellations: CalendarCancellation[];
  observations: ObservationRecord[];
  facts: DocumentFact[];
  calendarSeries: CalendarSeries[];
  pages: DocumentPage[];
  attachments: ImportAttachment[];
  issues: ImportIssue[];
  complete: boolean;
  horizon?: { start: string; end: string };
  confirmedAt?: string;
  configuration?: ImportConfiguration;
}
export interface ImportConfiguration {
  timezone?: string;
  calendarKind?: CalendarRecord["kind"];
  csvMapping?: Partial<Record<CSVField, string>>;
  delimiter?: string;
}
export interface ConfirmedImportBatch {
  id: string;
  sourceId: string;
  hash: string;
  parserVersion: string;
  status: "confirmed";
  allowedUse: "local_only";
  configuration: ImportConfiguration;
  configurationKey: string;
  confirmedAt: string;
  range?: { start: string; end: string };
  counts: {
    calendar: number;
    cancellations: number;
    observations: number;
    facts: number;
    pages: number;
  };
  recordIds: {
    calendar: string[];
    observations: string[];
    facts: string[];
    cancellations: string[];
    series: string[];
  };
  sourceRevision: number;
  replacesBatchIds: string[];
  supersededAt?: string;
}
export type CSVField =
  | "source"
  | "external_id"
  | "metric"
  | "start"
  | "end"
  | "timezone"
  | "value"
  | "unit"
  | "version";
export interface ImportOptions {
  timezone?: string;
  sourceId?: string;
  calendarKind?: CalendarRecord["kind"];
  horizonStart?: string;
  horizonEnd?: string;
  csvMapping?: Partial<Record<CSVField, string>>;
  delimiter?: string;
  maxOccurrences?: number;
  maxComputationMs?: number;
  maxRows?: number;
  maxBytes?: number;
  maxPages?: number;
  signal?: AbortSignal;
  onProgress?: (progress: { stage: string; progress: number }) => void;
  assetBase?: string;
}
export interface ImportFile {
  name: string;
  type?: string;
  data: ArrayBuffer | Uint8Array | string;
}
export interface ParsedImport {
  calendar?: CalendarRecord[];
  cancellations?: CalendarCancellation[];
  calendarSeries?: CalendarSeries[];
  observations?: ObservationRecord[];
  facts?: DocumentFact[];
  pages?: DocumentPage[];
  issues: ImportIssue[];
  complete: boolean;
}
