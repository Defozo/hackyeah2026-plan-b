import ICAL from "ical.js";
import { Temporal } from "@js-temporal/polyfill";
import {
  checkAbort,
  errorIssue,
  ImportError,
  instantFromLocal,
  stableId,
  validTimezone,
} from "./common";
import type {
  CalendarRecord,
  ImportOptions,
  ImportSource,
  ParsedImport,
} from "./types";

// ICAL does not ship a timezone database. IANA rules come from the browser's Intl
// database via Temporal, while explicit VTIMEZONE components take precedence.
class IanaZone extends ICAL.Timezone {
  constructor(id: string) {
    super({ tzid: id });
  }
  utcOffset(time: ICAL.Time): number {
    return (
      Temporal.PlainDateTime.from(
        time.toString().replace(/Z$/, ""),
      ).toZonedDateTime(this.tzid, { disambiguation: "compatible" })
        .offsetNanoseconds / 1e9
    );
  }
}
function propertyText(component: ICAL.Component, name: string): string {
  return String(component.getFirstPropertyValue(name) ?? "");
}
function eventVersion(component: ICAL.Component): number {
  const sequence = Number(component.getFirstPropertyValue("sequence") ?? 0);
  if (!Number.isInteger(sequence) || sequence < 0)
    throw new ImportError(
      "INVALID_SEQUENCE",
      "SEQUENCE zdarzenia jest nieprawidłowe.",
    );
  return sequence;
}
function timezoneOf(
  component: ICAL.Component,
  property: string,
  options: ImportOptions,
): string {
  const value = component.getFirstPropertyValue(property) as ICAL.Time | null;
  if (!value) throw new ImportError("MISSING_DATE", `Brakuje ${property}.`);
  const tzid = component.getFirstProperty(property)?.getParameter("tzid");
  if (tzid) return String(tzid);
  if (value.zone.tzid === "UTC") return "UTC";
  if (!options.timezone)
    throw new ImportError(
      "TIMEZONE_REQUIRED",
      "Czas bez strefy lub zdarzenie całodniowe wymaga wyboru strefy czasowej.",
    );
  if (!validTimezone(options.timezone))
    throw new ImportError(
      "UNKNOWN_TIMEZONE",
      `Nierozpoznana strefa ${options.timezone}.`,
    );
  return options.timezone;
}
function toInstant(
  time: ICAL.Time,
  zone: string,
  explicitZones: Set<string>,
): string {
  if (zone === "UTC")
    return instantFromLocal(
      `${time.toString().replace(/Z$/, "")}${time.isDate ? "T00:00:00" : ""}Z`,
    );
  if (explicitZones.has(zone)) {
    const copy = time.clone();
    copy.zone = ICAL.TimezoneService.get(zone)!;
    return new Date(copy.toUnixTime() * 1000).toISOString();
  }
  return instantFromLocal(time.toString().replace(/Z$/, ""), zone);
}
export function parseICS(
  text: string,
  source: ImportSource,
  options: ImportOptions = {},
): ParsedImport {
  const issues: ParsedImport["issues"] = [];
  const calendar: CalendarRecord[] = [];
  const cancellations: NonNullable<ParsedImport["cancellations"]> = [];
  const calendarSeries: NonNullable<ParsedImport["calendarSeries"]> = [];
  let root: ICAL.Component;
  try {
    root = new ICAL.Component(ICAL.parse(text));
  } catch {
    throw new ImportError(
      "INVALID_ICS",
      "Nie można odczytać kalendarza ICS. Sprawdź plik źródłowy.",
    );
  }
  if (root.name !== "vcalendar")
    throw new ImportError("INVALID_ICS", "Brakuje nagłówka VCALENDAR.");
  const explicitZones = new Set<string>();
  for (const component of root.getAllSubcomponents("vtimezone")) {
    const zone = new ICAL.Timezone(component);
    explicitZones.add(zone.tzid);
    ICAL.TimezoneService.register(zone);
  }
  const components = root.getAllSubcomponents("vevent");
  for (const component of components) {
    for (const name of [
      "dtstart",
      "dtend",
      "recurrence-id",
      "rdate",
      "exdate",
    ]) {
      for (const property of component.getAllProperties(name)) {
        const id = property.getParameter("tzid");
        if (id && !explicitZones.has(String(id))) {
          if (!validTimezone(String(id)))
            issues.push({
              code: "UNKNOWN_TIMEZONE",
              message: `Nierozpoznana strefa ${String(id)}. Nie potraktowano jej jako UTC.`,
              severity: "error",
            });
          else ICAL.TimezoneService.register(new IanaZone(String(id)));
        }
      }
    }
  }
  if (issues.some((i) => i.severity === "error"))
    return { calendar, cancellations, issues, complete: false };
  const startMs = Date.parse(options.horizonStart ?? new Date().toISOString());
  const endMs = Date.parse(
    options.horizonEnd ?? new Date(startMs + 90 * 86_400_000).toISOString(),
  );
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs)
    throw new ImportError(
      "INVALID_HORIZON",
      "Podaj poprawny zakres importu kalendarza.",
    );
  const groups = new Map<string, Map<string, ICAL.Component>>();
  for (const component of components) {
    try {
      const uid = propertyText(component, "uid");
      if (!uid)
        throw new ImportError(
          "MISSING_UID",
          "Zdarzenie nie ma UID. Popraw kalendarz przed importem.",
        );
      const recurrence = propertyText(component, "recurrence-id");
      const group = groups.get(uid) ?? new Map<string, ICAL.Component>();
      const previous = group.get(recurrence);
      const version = eventVersion(component);
      const modified =
        propertyText(component, "last-modified") ||
        propertyText(component, "dtstamp");
      const prevModified = previous
        ? propertyText(previous, "last-modified") ||
          propertyText(previous, "dtstamp")
        : "";
      if (
        !previous ||
        version > eventVersion(previous) ||
        (version === eventVersion(previous) && modified >= prevModified)
      )
        group.set(recurrence, component);
      groups.set(uid, group);
    } catch (error) {
      issues.push(errorIssue(error));
    }
  }
  let count = 0;
  const startedAt = performance.now();
  const bounds = () => {
    checkAbort(options.signal);
    if (
      ++count > (options.maxOccurrences ?? 10_000) ||
      performance.now() - startedAt > (options.maxComputationMs ?? 5000)
    )
      throw new ImportError(
        "RECURRENCE_LIMIT",
        "Nie przetworzono całego grafiku. Skróć zakres importu lub podziel kalendarz.",
      );
  };
  for (const [uid, group] of groups) {
    try {
      checkAbort(options.signal);
      const master = group.get("");
      const cancelledIds = new Set<string>();
      for (const [rid, component] of group) {
        if (
          propertyText(component, "status").toUpperCase() === "CANCELLED" ||
          propertyText(root, "method").toUpperCase() === "CANCEL"
        ) {
          cancellations.push({
            uid,
            ...(rid ? { recurrenceId: rid } : {}),
            version: eventVersion(component),
            sourceId: source.id,
          });
          cancelledIds.add(rid);
        }
      }
      if (cancelledIds.has("")) continue;
      if (master)
        calendarSeries.push({
          uid,
          version: eventVersion(master),
          sourceId: source.id,
        });
      // A detached update is useful even when the original series lives in the vault.
      const bases = master
        ? [master]
        : [...group.values()].filter(
            (c) => propertyText(c, "status").toUpperCase() !== "CANCELLED",
          );
      for (const base of bases) {
        if (!base.getFirstProperty("dtstart"))
          throw new ImportError(
            "MISSING_DATE",
            `Zdarzenie ${uid} nie ma początku.`,
          );
        const event = new ICAL.Event(base, { strictExceptions: false });
        if (master)
          for (const [rid, exception] of group)
            if (rid && !cancelledIds.has(rid))
              event.relateException(new ICAL.Event(exception));
        const zone = timezoneOf(base, "dtstart", options);
        const emit = (
          start: ICAL.Time,
          end: ICAL.Time,
          item: ICAL.Event,
          recurrenceId?: string,
        ) => {
          if (recurrenceId && cancelledIds.has(recurrenceId)) return;
          const itemZone = timezoneOf(item.component, "dtstart", options);
          const startUTC = toInstant(start, itemZone || zone, explicitZones);
          const endZone = item.component.getFirstProperty("dtend")
            ? timezoneOf(item.component, "dtend", options)
            : itemZone;
          const endUTC = toInstant(end, endZone, explicitZones);
          if (Date.parse(endUTC) <= Date.parse(startUTC))
            throw new ImportError(
              "INVALID_INTERVAL",
              `Zdarzenie ${uid} nie ma dodatniego czasu trwania.`,
            );
          if (Date.parse(startUTC) >= endMs || Date.parse(endUTC) <= startMs)
            return;
          if (
            propertyText(item.component, "transp").toUpperCase() ===
            "TRANSPARENT"
          )
            return;
          const externalId = `${uid}${recurrenceId ? `/${recurrenceId}` : ""}`;
          calendar.push({
            id: `cal-${stableId(`${source.id}|${externalId}`)}`,
            sourceId: source.id,
            externalId,
            uid,
            ...(recurrenceId ? { recurrenceId } : {}),
            version: Math.max(eventVersion(base), eventVersion(item.component)),
            start: startUTC,
            end: endUTC,
            timezone: itemZone,
            originalLocal: start.toString(),
            originalEndLocal: end.toString(),
            allDay: start.isDate,
            kind: options.calendarKind ?? "work",
            label:
              options.calendarKind === "rest"
                ? "Chroniony odpoczynek"
                : options.calendarKind === "busy"
                  ? "Zajęty czas"
                  : "Praca",
          });
        };
        if (event.isRecurring()) {
          const iterator = event.iterator();
          let occurrence: ICAL.Time | null;
          while ((occurrence = iterator.next())) {
            bounds();
            // Stop by wall-clock horizon plus offset allowance; moved exceptions
            // are processed separately below when their original date lies outside it.
            if (
              Date.parse(`${occurrence.toString().slice(0, 10)}T00:00:00Z`) >
              endMs + 2 * 86_400_000
            )
              break;
            if (cancelledIds.has(occurrence.toString())) continue;
            const details = event.getOccurrenceDetails(occurrence);
            emit(
              details.startDate,
              details.endDate,
              details.item,
              occurrence.toString(),
            );
          }
          for (const [rid, exception] of group)
            if (
              rid &&
              !cancelledIds.has(rid) &&
              !calendar.some((c) => c.uid === uid && c.recurrenceId === rid)
            ) {
              const detached = new ICAL.Event(exception);
              bounds();
              emit(detached.startDate, detached.endDate, detached, rid);
            }
        } else {
          bounds();
          emit(
            event.startDate,
            event.endDate,
            event,
            propertyText(base, "recurrence-id") || undefined,
          );
        }
      }
    } catch (error) {
      issues.push(errorIssue(error));
      if (error instanceof ImportError && error.code === "RECURRENCE_LIMIT")
        break;
    }
  }
  calendar.sort(
    (a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id),
  );
  return {
    calendar,
    cancellations,
    calendarSeries,
    issues,
    complete: !issues.some((i) => i.severity === "error"),
  };
}

export interface CalendarExport {
  uid: string;
  sequence: number;
  start: string;
  end: string;
  title?: string;
  cancelled?: boolean;
  reminderMinutes?: number;
  quietWindows?: { start: string; end: string }[];
}
export function exportICS(record: CalendarExport): string {
  if (!record.uid || /[\r\n]/.test(record.uid))
    throw new ImportError(
      "INVALID_UID",
      "Nieprawidłowy identyfikator kalendarza.",
    );
  if (Date.parse(record.end) <= Date.parse(record.start))
    throw new ImportError(
      "INVALID_INTERVAL",
      "Nieprawidłowy przedział kalendarza.",
    );
  const root = new ICAL.Component(["vcalendar", [], []]);
  root.updatePropertyWithValue("version", "2.0");
  root.updatePropertyWithValue("prodid", "-//Plan B//PL");
  root.updatePropertyWithValue(
    "method",
    record.cancelled ? "CANCEL" : "PUBLISH",
  );
  const component = new ICAL.Component("vevent");
  component.updatePropertyWithValue("uid", record.uid);
  component.updatePropertyWithValue("sequence", record.sequence);
  component.updatePropertyWithValue(
    "dtstamp",
    ICAL.Time.fromJSDate(new Date(), true),
  );
  component.updatePropertyWithValue(
    "dtstart",
    ICAL.Time.fromJSDate(new Date(record.start), true),
  );
  component.updatePropertyWithValue(
    "dtend",
    ICAL.Time.fromJSDate(new Date(record.end), true),
  );
  component.updatePropertyWithValue("summary", record.title ?? "Mój plan");
  component.updatePropertyWithValue(
    "status",
    record.cancelled ? "CANCELLED" : "CONFIRMED",
  );
  if (record.reminderMinutes !== undefined && !record.cancelled) {
    if (!Number.isFinite(record.reminderMinutes) || record.reminderMinutes < 0)
      throw new ImportError(
        "INVALID_REMINDER",
        "Nieprawidłowy czas przypomnienia.",
      );
    const at = Date.parse(record.start) - record.reminderMinutes * 60_000;
    if (
      !record.quietWindows?.some(
        (w) => at >= Date.parse(w.start) && at < Date.parse(w.end),
      )
    ) {
      const alarm = new ICAL.Component("valarm");
      alarm.updatePropertyWithValue("action", "DISPLAY");
      alarm.updatePropertyWithValue("description", "Sprawdź swój plan.");
      alarm.updatePropertyWithValue(
        "trigger",
        ICAL.Duration.fromSeconds(-record.reminderMinutes * 60),
      );
      component.addSubcomponent(alarm);
    }
  }
  root.addSubcomponent(component);
  return `${root.toString()}\r\n`;
}

export function exportCalendar(records: CalendarExport[]): string {
  const root = new ICAL.Component(["vcalendar", [], []]);
  root.updatePropertyWithValue("version", "2.0");
  root.updatePropertyWithValue("prodid", "-//Plan B//PL");
  for (const record of records) {
    const one = new ICAL.Component(ICAL.parse(exportICS(record)));
    root.addSubcomponent(one.getFirstSubcomponent("vevent")!);
  }
  return `${root.toString()}\r\n`;
}
