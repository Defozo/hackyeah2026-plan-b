import { DateTime } from "luxon";
import type { Candidate } from "@planb/domain";
import type { AppData } from "./vault";
import { time } from "./utils";
export function Timeline({
  data,
  days = 7,
  preview,
  planId,
}: {
  data: AppData;
  days?: number;
  preview?: Candidate;
  planId?: string;
}) {
  const start = DateTime.now().setZone(data.profile.timezone).startOf("day");
  const events = [
    ...data.busy,
    ...data.protectedWindows,
    ...data.plans
      .filter((p) => p.id !== planId && p.status !== "deferred")
      .map((p) => ({
        ...p,
        kind: p.status === "rest" ? "rest" : "activity",
        label:
          p.status === "rest"
            ? "Wybrany odpoczynek"
            : data.activities
                .flatMap((a) => a.variants)
                .find((v) => v.id === p.variantId)?.name,
      })),
    ...(preview
      ? [{ ...preview, kind: "activity", label: `Po zmianie: ${preview.name}` }]
      : []),
  ];
  return (
    <ol className={`timeline ${days > 1 ? "week-list" : ""}`}>
      {Array.from({ length: days }, (_, i) => {
        const d = start.plus({ days: i });
        const rows = events
          .filter(
            (e) =>
              Date.parse(e.start) < d.plus({ days: 1 }).toMillis() &&
              Date.parse(e.end) > d.toMillis(),
          )
          .sort((a, b) => a.start.localeCompare(b.start));
        return (
          <li key={i} className="timeline-day">
            {days > 1 && <h3>{d.setLocale("pl").toFormat("cccc, d LLL")}</h3>}
            {rows.length === 0 ? (
              <p className="caption">
                Brak zapisanych zajętych przedziałów. Dostępność określasz
                osobno.
              </p>
            ) : (
              rows.map((e) => (
                <div className={`timeline-event ${e.kind}`} key={e.id}>
                  <span className="timeline-time">
                    {time(e.start, data.profile.timezone)}
                    <small>{time(e.end, data.profile.timezone)}</small>
                  </span>
                  <div>
                    <strong>
                      {e.label ??
                        (e.kind === "rest"
                          ? "Chroniony odpoczynek"
                          : "Praca / zajęty czas")}
                    </strong>
                    <span className="caption">
                      {e.kind === "rest"
                        ? "Odpoczynek chroniony"
                        : e.kind === "activity"
                          ? "Aktywność"
                          : "Zajęty czas"}
                    </span>
                  </div>
                </div>
              ))
            )}
          </li>
        );
      })}
    </ol>
  );
}
