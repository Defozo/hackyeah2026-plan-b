import { Decoder, Stream } from "@garmin/fitsdk";
import { checkAbort, ImportError, stableId } from "./common";
import type {
  ImportOptions,
  ImportSource,
  ObservationRecord,
  ParsedImport,
} from "./types";

export function parseFIT(
  data: Uint8Array,
  source: ImportSource,
  options: ImportOptions = {},
): ParsedImport {
  checkAbort(options.signal);
  const decoder = new Decoder(
    Stream.fromArrayBuffer(new Uint8Array(data).buffer),
  );
  if (!decoder.isFIT() || !decoder.checkIntegrity())
    throw new ImportError(
      "INVALID_FIT",
      "Plik FIT jest uszkodzony, niepełny lub nie przeszedł kontroli CRC. Wyeksportuj go ponownie.",
    );
  const { messages, errors } = decoder.read({
    convertDateTimesToDates: true,
    convertTypesToStrings: true,
    includeUnknownData: false,
    mergeHeartRates: false,
    decodeMemoGlobs: false,
  });
  if (errors.length)
    throw new ImportError(
      "FIT_DECODE",
      "Nie udało się w całości odczytać pliku FIT. Żadne dane nie zostały zapisane.",
    );
  checkAbort(options.signal);
  const sessions = (messages.sessionMesgs ?? []) as Record<string, unknown>[];
  if (!sessions.length)
    throw new ImportError(
      "UNSUPPORTED_FIT",
      "Ten plik FIT nie zawiera obsługiwanych sesji aktywności. Użyj eksportu aktywności albo CSV.",
    );
  const observations: ObservationRecord[] = [];
  const issues: ParsedImport["issues"] = [];
  for (const [index, session] of sessions.entries()) {
    checkAbort(options.signal);
    const start =
      session.startTime instanceof Date ? session.startTime : undefined;
    const seconds =
      typeof session.totalElapsedTime === "number"
        ? session.totalElapsedTime
        : undefined;
    const activeSeconds =
      typeof session.totalTimerTime === "number"
        ? session.totalTimerTime
        : seconds;
    const end =
      session.timestamp instanceof Date
        ? session.timestamp
        : start && seconds !== undefined
          ? new Date(start.getTime() + seconds * 1000)
          : undefined;
    if (
      !start ||
      !end ||
      !Number.isFinite(start.getTime()) ||
      !Number.isFinite(end.getTime()) ||
      end <= start ||
      activeSeconds === undefined ||
      !Number.isFinite(activeSeconds) ||
      activeSeconds < 0 ||
      typeof session.sport !== "string"
    ) {
      issues.push({
        code: "INVALID_FIT_SESSION",
        message: `Sesja ${index + 1} nie ma wiarygodnego czasu lub typu aktywności.`,
        severity: "error",
      });
      continue;
    }
    const externalId = `${start.toISOString()}/${session.sport}/${index}`;
    observations.push({
      id: `fit-${stableId(`${source.id}|${externalId}`)}`,
      sourceId: source.id,
      sourceName: source.name,
      externalId,
      version: 0,
      metric: "activity_minutes",
      value: activeSeconds / 60,
      unit: "min",
      originalValue: String(activeSeconds),
      originalUnit: "s",
      start: start.toISOString(),
      end: end.toISOString(),
      timezone: "UTC",
      originalLocal: start.toISOString(),
      activityType: session.sport,
      status: "pending",
    });
  }
  // Deliberately project only these fields. No records, GPS, serial numbers,
  // heart rate, developer data or routes escape the decoder into stored output.
  return {
    observations,
    issues,
    complete: !issues.some((i) => i.severity === "error"),
  };
}
