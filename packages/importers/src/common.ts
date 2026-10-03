import { Temporal } from "@js-temporal/polyfill";
import type { ImportIssue } from "./types";

export class ImportError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "ImportError";
  }
}
export function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted)
    throw new DOMException("Import anulowany.", "AbortError");
}
export async function sha256(data: Uint8Array | string): Promise<string> {
  const bytes =
    typeof data === "string" ? new TextEncoder().encode(data) : data;
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer),
    ),
  ]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}
export function stableId(text: string): string {
  // Identity only, never used as an integrity/security hash.
  let h = 2166136261;
  for (const c of text) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
export function validTimezone(zone: string): boolean {
  try {
    Temporal.Now.zonedDateTimeISO(zone);
    return true;
  } catch {
    return false;
  }
}
export function instantFromLocal(value: string, timezone?: string): string {
  if (/T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(value))
    return Temporal.Instant.from(value).toString();
  if (!timezone)
    throw new ImportError(
      "TIMEZONE_REQUIRED",
      "Wybierz strefę czasową dla czasu bez strefy.",
    );
  if (!validTimezone(timezone))
    throw new ImportError(
      "UNKNOWN_TIMEZONE",
      `Nierozpoznana strefa czasowa: ${timezone}.`,
    );
  try {
    return Temporal.PlainDateTime.from(
      value.includes("T") ? value : `${value}T00:00:00`,
    )
      .toZonedDateTime(timezone, { disambiguation: "reject" })
      .toInstant()
      .toString();
  } catch {
    throw new ImportError(
      "AMBIGUOUS_LOCAL_TIME",
      `Czas ${value} jest niepoprawny lub niejednoznaczny w ${timezone}. Podaj czas z przesunięciem UTC.`,
    );
  }
}
export function errorIssue(error: unknown, row?: number): ImportIssue {
  return {
    code: error instanceof ImportError ? error.code : "INVALID_RECORD",
    message: error instanceof Error ? error.message : "Nieprawidłowy rekord.",
    severity: "error",
    ...(row ? { row } : {}),
  };
}
