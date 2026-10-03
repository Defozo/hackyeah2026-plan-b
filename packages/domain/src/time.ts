import { DateTime, IANAZone } from "luxon";
import type { Interval } from "./types";

interface TimeMemo {
  epochs: Map<string, number>;
  localTimes: Map<string, string>;
  preferredInstants: Map<string, number[]>;
  zones: Set<string>;
}
let timeMemo: TimeMemo | undefined;
/** Synchronous calculation scope. Nested scopes restore the parent; no timestamps survive the outer call. */
export function withTimeMemo<T>(calculate: () => T): T {
  const previous = timeMemo;
  const current: TimeMemo = {
    epochs: new Map(),
    localTimes: new Map(),
    preferredInstants: new Map(),
    zones: new Set(),
  };
  timeMemo = current;
  try {
    return calculate();
  } finally {
    current.epochs.clear();
    current.localTimes.clear();
    current.preferredInstants.clear();
    current.zones.clear();
    timeMemo = previous;
  }
}

export function epoch(value: string): number {
  const cached = timeMemo?.epochs.get(value);
  if (cached !== undefined) return cached;
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(value))
    throw new Error("Czas musi zawierać jawny offset UTC.");
  const parsed = DateTime.fromISO(value, { setZone: true });
  if (!parsed.isValid) throw new Error("Nieprawidłowa data.");
  const milliseconds = parsed.toMillis();
  timeMemo?.epochs.set(value, milliseconds);
  return milliseconds;
}
export const iso = (value: number): string => new Date(value).toISOString();
export function assertTimezone(zone: string): void {
  if (timeMemo?.zones.has(zone)) return;
  if (zone !== "UTC" && !IANAZone.isValidZone(zone))
    throw new Error("Nieznana strefa czasowa.");
  timeMemo?.zones.add(zone);
}
export function localTime(value: string, timezone: string): string {
  assertTimezone(timezone);
  const key = JSON.stringify([value, timezone]);
  const cached = timeMemo?.localTimes.get(key);
  if (cached !== undefined) return cached;
  const result = DateTime.fromMillis(epoch(value), { zone: timezone }).toISO({
    suppressMilliseconds: true,
  })!;
  timeMemo?.localTimes.set(key, result);
  return result;
}
/** Floating input is accepted only if the local instant exists and is unambiguous. */
export function resolveLocalTime(
  local: string,
  timezone: string,
  offsetMinutes?: number,
): string {
  assertTimezone(timezone);
  const value = DateTime.fromISO(local, { zone: timezone });
  if (
    !value.isValid ||
    value.toFormat("yyyy-MM-dd'T'HH:mm") !== local.slice(0, 16)
  ) {
    throw new Error(
      "Ta godzina lokalna nie istnieje. Wybierz poprawną godzinę.",
    );
  }
  const possible = value.getPossibleOffsets();
  if (possible.length > 1 && offsetMinutes === undefined)
    throw new Error("Godzina występuje dwukrotnie. Wskaż offset.");
  const chosen =
    offsetMinutes === undefined
      ? value
      : possible.find((item) => item.offset === offsetMinutes);
  if (!chosen) throw new Error("Offset nie pasuje do strefy i daty.");
  return chosen.toUTC().toISO()!;
}
export function overlaps(
  a: Pick<Interval, "start" | "end">,
  b: Pick<Interval, "start" | "end">,
): boolean {
  return epoch(a.start) < epoch(b.end) && epoch(b.start) < epoch(a.end);
}
export function contains(
  outer: Pick<Interval, "start" | "end">,
  inner: Pick<Interval, "start" | "end">,
): boolean {
  return (
    epoch(outer.start) <= epoch(inner.start) &&
    epoch(inner.end) <= epoch(outer.end)
  );
}
export function validateInterval(value: Interval): void {
  if (!value.id || epoch(value.end) <= epoch(value.start))
    throw new Error("Przedział musi mieć dodatnią długość.");
  if (value.timezone) assertTimezone(value.timezone);
}
/** Merge overlapping availability first: midnight and adjacent windows remain continuous. */
export function subtractIntervals(
  availability: Interval[],
  blocked: Interval[],
  start: string,
  end: string,
): Interval[] {
  const minimum = epoch(start),
    maximum = epoch(end);
  const ranges = availability
    .map((a) => [
      Math.max(minimum, epoch(a.start)),
      Math.min(maximum, epoch(a.end)),
    ])
    .filter(([a, b]) => a! < b!)
    .sort((a, b) => a[0]! - b[0]!);
  const merged: number[][] = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range[0]! <= last[1]!) last[1] = Math.max(last[1]!, range[1]!);
    else merged.push([...range]);
  }
  const busy = blocked
    .map((a) => [epoch(a.start), epoch(a.end)])
    .sort((a, b) => a[0]! - b[0]!);
  let free = merged;
  for (const [a, b] of busy)
    free = free.flatMap(([s, e]) => {
      if (b! <= s! || a! >= e!) return [[s!, e!]];
      return [
        [s!, Math.min(a!, e!)],
        [Math.max(b!, s!), e!],
      ].filter(([x, y]) => x! < y!);
    });
  return free.map(([s, e]) => ({
    id: `free:${s}:${e}`,
    start: iso(s!),
    end: iso(e!),
    kind: "available",
  }));
}
export function horizonEnd(now: string, timezone: string): string {
  return DateTime.fromMillis(epoch(now), { zone: timezone })
    .plus({ days: 7 })
    .toUTC()
    .toISO()!;
}
export function localDate(value: string, timezone: string): string {
  return DateTime.fromMillis(epoch(value), { zone: timezone }).toISODate()!;
}
export function preferredInstants(
  window: Interval,
  minutes: number[],
  timezone: string,
): number[] {
  const key = JSON.stringify([window.start, window.end, minutes, timezone]);
  const cached = timeMemo?.preferredInstants.get(key);
  if (cached !== undefined) return [...cached];
  const result: number[] = [];
  let day = DateTime.fromMillis(epoch(window.start), {
    zone: timezone,
  }).startOf("day");
  const last = epoch(window.end);
  while (day.toMillis() < last) {
    for (const minute of minutes) {
      const hour = Math.floor(minute / 60),
        min = minute % 60;
      const possible = day.set({ hour, minute: min }).getPossibleOffsets();
      for (const value of possible) {
        if (value.hour === hour && value.minute === min)
          result.push(value.toMillis());
      }
    }
    day = day.plus({ days: 1 }).startOf("day");
  }
  timeMemo?.preferredInstants.set(key, [...result]);
  return result;
}
