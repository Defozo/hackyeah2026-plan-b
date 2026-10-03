import { useMemo, useState } from "react";
import { summarizeHistory, recordOutcome } from "@planb/domain";
import { DateTime } from "luxon";
import type { ViewProps } from "./App";
import { Button, DialogBox, Empty, Field } from "./components";
import { fmt, now, uid, errorText } from "./utils";
export default function History({ data, update, notify }: ViewProps) {
  const [days, setDays] = useState<7 | 28>(7),
    [edit, setEdit] = useState<string | null>(null),
    [note, setNote] = useState(""),
    [energy, setEnergy] = useState(""),
    [tension, setTension] = useState("");
  const h = useMemo(() => summarizeHistory(data, days, now()), [data, days]);
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">TWOJE OBSERWACJE, BEZ OCEN</p>
          <h1>
            Historia<span>.</span>
          </h1>
          <p>Sprawdź, co wybierasz, co robisz i gdzie brakuje odpowiedzi.</p>
        </div>
        <div className="segmented">
          {([7, 28] as const).map((n) => (
            <Button
              key={n}
              className={days === n ? "selected" : ""}
              onPress={() => setDays(n)}
            >
              {n} dni
            </Button>
          ))}
        </div>
      </div>
      <div className="stats">
        <div>
          <strong>{h.counts.decisions}</strong>
          <span>świadomych decyzji</span>
        </div>
        <div>
          <strong>{h.counts.done}</strong>
          <span>potwierdzonych działań</span>
        </div>
        <div>
          <strong>{h.counts.noResponse}</strong>
          <span>bez odpowiedzi</span>
        </div>
        <div>
          <strong>{h.counts.rest}</strong>
          <span>wyborów odpoczynku</span>
        </div>
      </div>
      <section className="panel">
        <h2>Twoje decyzje</h2>
        {h.rows.length === 0 ? (
          <Empty>
            Nie ma jeszcze decyzji w tym okresie. Historia pojawi się po
            pierwszej zmianie planu.
          </Empty>
        ) : (
          <div className="table-scroll">
            <table>
              <caption>
                Okres: {fmt(h.start, data.profile.timezone)} do{" "}
                {fmt(h.end, data.profile.timezone)}. Wybór nie oznacza
                wykonania.
              </caption>
              <thead>
                <tr>
                  <th>Data i przeszkoda</th>
                  <th>Pierwotny zamiar</th>
                  <th>Wybór</th>
                  <th>Deklarowany rezultat</th>
                  <th>Szczegóły</th>
                </tr>
              </thead>
              <tbody>
                {h.rows.map(({ decision: d, outcome: o }) => (
                  <tr key={d.id}>
                    <td>
                      {fmt(d.createdAt, data.profile.timezone)}
                      <small>{d.obstacle ?? "Nie podano"}</small>
                    </td>
                    <td>
                      <strong>
                        {d.sourceRemoved
                          ? "Źródło usunięto"
                          : (d.originalPlan.label ??
                            data.activities
                              .flatMap((a) => a.variants)
                              .find((v) => v.id === d.originalPlan.variantId)
                              ?.name ??
                            "Pierwotna aktywność")}
                      </strong>
                      <small>
                        {fmt(d.originalPlan.start, data.profile.timezone)} do{" "}
                        {fmt(d.originalPlan.end, data.profile.timezone)}
                      </small>
                      {!d.sourceRemoved && (
                        <small>
                          Cel:{" "}
                          {data.intents.find(
                            (intent) => intent.id === d.originalPlan.intentId,
                          )?.label ?? "Brak opisu celu"}
                        </small>
                      )}
                    </td>
                    <td>
                      {d.kind === "rest"
                        ? "Odpoczynek"
                        : d.kind === "defer"
                          ? "Odłożenie decyzji"
                          : (d.candidate?.name ?? "Źródło usunięto")}
                      {d.candidate && (
                        <small>
                          {fmt(d.candidate.start, data.profile.timezone)} do{" "}
                          {fmt(d.candidate.end, data.profile.timezone)}
                        </small>
                      )}
                    </td>
                    <td>
                      <span className="tag">
                        {o?.status === "done"
                          ? "Zrobiłem"
                          : o?.status === "different"
                            ? "Zrobiłem inaczej"
                            : o?.status === "not_done"
                              ? "Nie podjąłem działania"
                              : "Brak odpowiedzi"}
                      </span>
                    </td>
                    <td>
                      <details>
                        <summary>Źródła decyzji</summary>
                        {d.sourceRemoved ? (
                          <p>Źródło usunięto.</p>
                        ) : d.sourceIds.length ? (
                          d.sourceIds.map((id) => (
                            <p key={id}>
                              {data.sources.find((source) => source.id === id)
                                ?.name ?? "Źródło niedostępne"}
                            </p>
                          ))
                        ) : (
                          <p>Własny wpis.</p>
                        )}
                      </details>
                      <Button
                        className="text-button"
                        onPress={() => {
                          setEdit(d.id);
                          setNote(o?.note ?? "");
                          setEnergy(o?.energy?.toString() ?? "");
                          setTension(o?.tension?.toString() ?? "");
                        }}
                      >
                        Uzupełnij
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <div className="reflection-grid">
        <section className="panel">
          <h2>W podobnych sytuacjach</h2>
          <p className="caption">{h.similarityDefinition}</p>
          {h.similar.map((s, i) => (
            <p key={i}>
              W {s.chosen} podobnych sytuacjach wybrano{" "}
              {data.activities
                .flatMap((a) => a.variants)
                .find((v) => v.id === s.variantId)?.name ?? "ten wariant"}
              . Potwierdzono wykonanie: {s.done}. Bez odpowiedzi: {s.noResponse}
              .
            </p>
          ))}
          <p className="caption">
            To opis własnej historii. Nie pokazuje przyczyn ani
            prawdopodobieństwa powodzenia.
          </p>
        </section>
        <section className="panel">
          <h2>Pokrycie danych</h2>
          {h.coverage.length === 0 ? (
            <p>Nie mam danych o śnie ani pomiarach z tych dni.</p>
          ) : (
            h.coverage.map((c, i) => (
              <div key={i} className="coverage">
                <strong>
                  {c.metric} · {c.sourceName}
                </strong>
                <p>
                  {c.coveredDays} z {c.totalDays} dni · {c.records} zapisów
                </p>
                <progress max={c.totalDays} value={c.coveredDays} />
                {c.overlapIds.length > 0 && (
                  <p className="warning-text">
                    Nakładające się źródła. Wyników nie sumujemy.
                  </p>
                )}
                <details>
                  <summary>Pokaż źródło i zapisy</summary>
                  {data.observations
                    .filter(
                      (o) =>
                        o.sourceId === c.sourceId &&
                        o.metric === c.metric &&
                        o.status === "confirmed" &&
                        Date.parse(o.start) <= Date.parse(h.end) &&
                        (Date.parse(o.end) > Date.parse(h.start) ||
                          (Date.parse(o.start) === Date.parse(o.end) &&
                            Date.parse(o.start) === Date.parse(h.start))),
                    )
                    .map((o) => (
                      <p key={o.id}>
                        {DateTime.fromISO(o.start, {
                          zone: data.profile.timezone,
                        }).toFormat("dd.LL.yyyy")}
                        : {o.value ?? "brak"} {o.unit} · {o.status}
                      </p>
                    ))}
                </details>
              </div>
            ))
          )}
        </section>
      </div>
      {edit && (
        <DialogBox title="Jak poszło?" onClose={() => setEdit(null)}>
          <Field label="Twoja obserwacja (opcjonalnie)">
            <textarea value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <div className="form-grid">
            <Field label="Energia 1–5 (opcjonalnie)">
              <input
                type="number"
                min={1}
                max={5}
                value={energy}
                onChange={(e) => setEnergy(e.target.value)}
              />
            </Field>
            <Field label="Napięcie 1–5 (opcjonalnie)">
              <input
                type="number"
                min={1}
                max={5}
                value={tension}
                onChange={(e) => setTension(e.target.value)}
              />
            </Field>
          </div>
          <p className="caption">
            Samoocena nie jest przeliczana na zdolność do wysiłku.
          </p>
          <div className="button-row">
            {(
              [
                { v: "done", l: "Zrobiłem" },
                { v: "different", l: "Zrobiłem inaczej" },
                { v: "not_done", l: "Nie podjąłem działania" },
              ] as const
            ).map((s) => (
              <Button
                key={s.v}
                className="secondary"
                onPress={async () => {
                  try {
                    if (
                      [energy, tension].some(
                        (x) =>
                          x !== "" &&
                          (!Number.isInteger(Number(x)) ||
                            Number(x) < 1 ||
                            Number(x) > 5),
                      )
                    )
                      throw Error("Samoocena powinna być liczbą 1–5.");
                    await update(
                      recordOutcome(data, {
                        id: uid(),
                        decisionId: edit,
                        status: s.v,
                        note,
                        energy: energy ? Number(energy) : undefined,
                        tension: tension ? Number(tension) : undefined,
                        recordedAt: now(),
                      }),
                    );
                    setEdit(null);
                    notify("Rezultat zapisany.");
                  } catch (e) {
                    notify(errorText(e));
                  }
                }}
              >
                {s.l}
              </Button>
            ))}
          </div>
        </DialogBox>
      )}
    </>
  );
}
