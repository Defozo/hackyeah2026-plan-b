import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  Check,
  Clock,
  Footprints,
  Leaf,
  MapPin,
  RefreshCw,
  SlidersHorizontal,
} from "lucide-react";
import {
  acceptRevision,
  recordOutcome,
  rejectPreview,
  type Candidate,
  type RepairInput,
  type RepairResult,
} from "@planb/domain";
import type { ViewProps } from "./App";
import { Button, DialogBox, Empty, Field } from "./components";
import { errorText, fmt, now, uid } from "./utils";
import { ActivityForm } from "./Week";
import { Timeline } from "./Timeline";
export default function Today({ data, update, notify }: ViewProps) {
  const [setup, setSetup] = useState(false),
    [repair, setRepair] = useState(false),
    [obstacle, setObstacle] = useState("Mniej czasu"),
    [minutes, setMinutes] = useState(20),
    [intentId, setIntentId] = useState(
      data.plans.find((p) => new Date(p.end) > new Date())?.intentId ??
        data.intents[0]?.id ??
        "",
    ),
    [allowChange, setAllowChange] = useState(false),
    [rest, setRest] = useState(false),
    [answers, setAnswers] = useState<Record<string, boolean | number | "skip">>(
      {},
    ),
    [result, setResult] = useState<RepairResult | null>(null),
    [preview, setPreview] = useState<Candidate | null>(null),
    [saving, setSaving] = useState(false),
    [selectedPlan, setSelectedPlan] = useState("");
  const plans = data.plans.filter((p) => new Date(p.end) > new Date());
  const plan =
    plans.find((p) => p.id === selectedPlan) ??
    plans.find((p) => p.status === "accepted" || p.status === "conflict") ??
    plans[0];
  const variant = data.activities
    .flatMap((a) => a.variants)
    .find((v) => v.id === plan?.variantId);
  const intent = data.intents.find((i) => i.id === intentId) ?? data.intents[0];
  const input = useMemo<RepairInput | null>(() => {
    if (!plan || !intent) return null;
    const start = Math.max(Date.now(), Date.parse(plan.start));
    const cutoff = new Date(start + minutes * 60000).toISOString();
    return {
      now: now(),
      timezone: data.profile.timezone,
      intent,
      plan,
      activities: data.activities,
      availability: data.availability.map((w) =>
        obstacle === "Mniej czasu" &&
        Date.parse(w.start) <= start &&
        Date.parse(w.end) > start
          ? {
              ...w,
              end: Date.parse(w.end) > Date.parse(cutoff) ? cutoff : w.end,
            }
          : w,
      ),
      busy: data.busy,
      protectedWindows: data.protectedWindows,
      acceptedPlans: data.plans,
      constraints: data.constraints,
      resources: data.resources,
      priorities: data.profile.priorities,
      answers,
      allowIntentChange: allowChange,
      restToday: rest,
      history: data.decisions,
      inputVersion: data.revision,
    };
  }, [data, plan, intent, minutes, obstacle, answers, allowChange, rest]);
  useEffect(() => {
    if (!repair || !input) {
      setResult(null);
      return;
    }
    setResult(null);
    const worker = new Worker(new URL("./engine.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (e) => {
      if (e.data.error) notify(e.data.error);
      else setResult(e.data.result);
    };
    worker.onerror = () =>
      notify("Nie udało się przeliczyć planu. Spróbuj ponownie.");
    worker.postMessage(input);
    return () => worker.terminate();
  }, [repair, input]);
  async function accept(
    kind: "activity" | "rest" | "defer",
    candidate?: Candidate,
  ) {
    if (!input || !result || saving) return;
    setSaving(true);
    try {
      const next = acceptRevision(data, {
        operationId: uid(),
        expectedRevision: data.revision,
        input,
        result,
        choice:
          kind === "activity" ? { kind, candidateId: candidate!.id } : { kind },
        now: now(),
        obstacle,
      });
      await update(next);
      setRepair(false);
      setPreview(null);
      notify(
        "Zmiana jest zapisana na tym urządzeniu. Wybór nie oznacza jeszcze wykonania.",
      );
    } catch (e) {
      notify(errorText(e));
    } finally {
      setSaving(false);
    }
  }
  const [outcomeDetails, setOutcomeDetails] = useState<
    Record<string, { note?: string; energy?: string; tension?: string }>
  >({});
  const pending = data.decisions
    .filter(
      (d) =>
        d.kind !== "defer" &&
        Date.parse(d.candidate?.end ?? d.originalPlan.end) <= Date.now() &&
        !data.outcomes.some(
          (o) => o.decisionId === d.id && o.status !== "no_response",
        ),
    )
    .slice(-3)
    .reverse();
  const showOutcomeReminder =
    data.reminders &&
    !data.protectedWindows.some(
      (window) =>
        Date.parse(window.start) <= Date.now() &&
        Date.now() < Date.parse(window.end),
    );
  const totalLabel = variant
    ? variant.travelMinutes === null
      ? "Pełny czas nieznany"
      : `${variant.durationMinutes + variant.preparationMinutes + variant.travelMinutes} min łącznie`
    : "Brak opisu wariantu";
  async function reject() {
    if (!plan || !result) return;
    try {
      await update(rejectPreview(data, plan.id, result, input ?? undefined));
      setRepair(false);
      setPreview(null);
      notify(
        "Podgląd odrzucony. Poprzedni zamiar pozostał zapisany z aktualnym oznaczeniem konfliktu.",
      );
    } catch (e) {
      notify(errorText(e));
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">PRZESTRZEŃ NA TWÓJ DZIEŃ</p>
          <h1>
            Dobry plan umie się zmienić<span>.</span>
          </h1>
          <p>Nie musisz zaczynać od nowa. Wybierz swój następny krok.</p>
        </div>
        <span className="date-label">
          <CalendarDays size={18} />
          {new Intl.DateTimeFormat("pl", {
            day: "numeric",
            month: "long",
            weekday: "long",
            timeZone: data.profile.timezone,
          }).format(new Date())}
        </span>
      </div>
      {!plan ? (
        <section className="hero panel">
          <div className="round-icon">
            <Footprints />
          </div>
          <h2>Od czego chcesz zacząć?</h2>
          <p>
            Opisz jedną aktywność, którą już znasz, i czas, który masz do
            dyspozycji.
          </p>
          <Button className="primary" onPress={() => setSetup(true)}>
            Dodaj pierwszą aktywność <ArrowRight size={18} />
          </Button>
        </section>
      ) : (
        <div className="today-grid">
          <section className="plan-card panel">
            <div className="section-top">
              <span className="eyebrow">TWÓJ OBECNY ZAMIAR</span>
              <span className="tag">
                {plan.status === "rest"
                  ? "Wybrany odpoczynek"
                  : plan.status === "deferred"
                    ? "Decyzja odłożona"
                    : plan.status === "conflict"
                      ? "Zamiar wymaga sprawdzenia"
                      : "Twój plan"}
              </span>
            </div>
            <p className="intent-label">
              <Leaf size={16} />
              {data.intents.find((i) => i.id === plan.intentId)?.label}
            </p>
            <div className="plan-title">
              <div>
                <h2>{variant?.name ?? "Zaplanowana aktywność"}</h2>
                <p>{fmt(plan.start, data.profile.timezone)}</p>
              </div>
              <div className="activity-illustration">
                <Footprints size={52} strokeWidth={1.35} />
              </div>
            </div>
            <div className="plan-facts">
              <span>
                <Clock size={17} />
                {totalLabel}
              </span>
              <span>
                <MapPin size={17} />
                {variant?.locationId}
              </span>
            </div>
            {variant && (
              <p className="caption">
                {variant.durationMinutes} min aktywności +{" "}
                {variant.preparationMinutes} min przygotowania +{" "}
                {variant.travelMinutes === null
                  ? "nieznany czas dojazdu"
                  : `${variant.travelMinutes} min dojazdu`}
              </p>
            )}
            {plan.status === "conflict" && (
              <div className="conflict">
                <div>
                  <strong>Zamiar wymaga ponownego sprawdzenia</strong>
                  {plan.conflictReasons?.map((r, i) => (
                    <p key={i}>{r.message}</p>
                  ))}
                </div>
              </div>
            )}
            <div className="card-divider" />
            <div className="section-top">
              <div>
                <h3>Coś się zmieniło?</h3>
                <p className="caption">Dopasuj ten zamiar do nowej sytuacji.</p>
              </div>
              <Button
                className="primary"
                isDisabled={Date.parse(plan.start) < Date.now()}
                onPress={() => {
                  setAnswers({});
                  setRest(false);
                  setObstacle("Mniej czasu");
                  setAllowChange(false);
                  setRepair(true);
                  setIntentId(plan.intentId);
                }}
              >
                Dzień się zmienił <ArrowUpRight size={18} />
              </Button>
            </div>
            {plans.length > 1 && (
              <Field label="Inny zamiar">
                <select
                  value={plan.id}
                  onChange={(e) => setSelectedPlan(e.target.value)}
                >
                  {plans.map((p) => (
                    <option key={p.id} value={p.id}>
                      {
                        data.activities
                          .flatMap((a) => a.variants)
                          .find((v) => v.id === p.variantId)?.name
                      }{" "}
                      · {fmt(p.start, data.profile.timezone)}
                    </option>
                  ))}
                </select>
              </Field>
            )}
          </section>
          <aside className="day-summary panel">
            <div className="section-top">
              <h2>Rytm dnia</h2>
              <Clock size={18} />
            </div>
            <Timeline data={data} days={1} />
            <div className="rest-note">
              <Leaf size={19} />
              <p>
                Odpoczynek jest częścią planu.
                <br />
                <strong>Nie trzeba go nadrabiać.</strong>
              </p>
            </div>
          </aside>
        </div>
      )}
      <div className="section-title">
        <h2>Chwila dla siebie</h2>
        <span className="caption">Bez codziennego obowiązku</span>
      </div>
      <div className="reflection-grid">
        {showOutcomeReminder && (
          <section className="reflection panel">
            <div className="round-icon">
              <Check size={21} />
            </div>
            <div>
              <h3>Jak poszło ostatnim razem?</h3>
              <p>Decyzja i wykonanie to dwie różne rzeczy.</p>
            </div>
            {pending.length === 0 ? (
              <p className="caption">
                Nie masz decyzji czekających na odpowiedź.
              </p>
            ) : (
              pending.map((d) => (
                <div className="outcome" key={d.id}>
                  <strong>
                    {d.kind === "rest"
                      ? "Odpoczynek"
                      : d.kind === "defer"
                        ? "Odłożona decyzja"
                        : d.candidate?.name}
                  </strong>
                  <span className="caption">
                    {fmt(d.createdAt, data.profile.timezone)}
                  </span>
                  <details>
                    <summary>Dodaj własną obserwację (opcjonalnie)</summary>
                    <Field label="Przeszkoda lub krótka notatka">
                      <textarea
                        maxLength={2000}
                        value={outcomeDetails[d.id]?.note ?? ""}
                        onChange={(e) =>
                          setOutcomeDetails({
                            ...outcomeDetails,
                            [d.id]: {
                              ...outcomeDetails[d.id],
                              note: e.target.value,
                            },
                          })
                        }
                      />
                    </Field>
                    {(["energy", "tension"] as const).map((key) => (
                      <Field
                        key={key}
                        label={
                          key === "energy"
                            ? "Energia (1–5, opcjonalnie)"
                            : "Napięcie (1–5, opcjonalnie)"
                        }
                      >
                        <select
                          value={outcomeDetails[d.id]?.[key] ?? ""}
                          onChange={(e) =>
                            setOutcomeDetails({
                              ...outcomeDetails,
                              [d.id]: {
                                ...outcomeDetails[d.id],
                                [key]: e.target.value,
                              },
                            })
                          }
                        >
                          <option value="">Nie podaję</option>
                          {Array.from({ length: 5 }, (_, i) => (
                            <option key={i + 1} value={i + 1}>
                              {i + 1}
                            </option>
                          ))}
                        </select>
                      </Field>
                    ))}
                    <p className="caption">
                      To samoobserwacja. Nie oceniamy zdolności do wysiłku.
                    </p>
                  </details>
                  <div className="button-row">
                    {(
                      [
                        { key: "done", label: "Zrobiłem" },
                        { key: "different", label: "Zrobiłem inaczej" },
                        { key: "not_done", label: "Nie podjąłem działania" },
                      ] as const
                    ).map((o) => (
                      <Button
                        key={o.key}
                        className="secondary compact"
                        onPress={async () => {
                          try {
                            await update(
                              recordOutcome(data, {
                                id: uid(),
                                decisionId: d.id,
                                status: o.key,
                                recordedAt: now(),
                                note:
                                  outcomeDetails[d.id]?.note?.trim() ||
                                  undefined,
                                energy: outcomeDetails[d.id]?.energy
                                  ? Number(outcomeDetails[d.id]?.energy)
                                  : undefined,
                                tension: outcomeDetails[d.id]?.tension
                                  ? Number(outcomeDetails[d.id]?.tension)
                                  : undefined,
                              }),
                            );
                            notify("Rezultat został zapisany.");
                          } catch (e) {
                            notify(errorText(e));
                          }
                        }}
                      >
                        {o.label}
                      </Button>
                    ))}
                  </div>
                </div>
              ))
            )}
          </section>
        )}
        <section className="gentle-card">
          <Leaf size={28} />
          <h3>
            Plan pasuje do Ciebie.
            <br />
            Nie odwrotnie.
          </h3>
          <p>
            Możesz wybrać inną drogę, odpocząć albo wrócić do decyzji później.
            Każdy z tych wyborów ma tu swoje miejsce.
          </p>
          <Button className="text-button" onPress={() => setSetup(true)}>
            Dodaj własny wariant <ArrowRight size={16} />
          </Button>
        </section>
      </div>
      {setup && (
        <ActivityForm
          data={data}
          update={update}
          notify={notify}
          onClose={() => setSetup(false)}
        />
      )}
      {repair && (
        <DialogBox
          title={preview ? "Zobacz zmianę przed zapisem" : "Dzień się zmienił"}
          onClose={() => {
            setRepair(false);
            setPreview(null);
          }}
        >
          {preview ? (
            <>
              <div className="compare">
                <div>
                  <span className="eyebrow">BYŁO</span>
                  <h3>{variant?.name}</h3>
                  <p>
                    {plan && fmt(plan.start, data.profile.timezone)} ·{" "}
                    {totalLabel}
                  </p>
                </div>
                <div>
                  <span className="eyebrow">PO ZMIANIE</span>
                  <h3>{preview.name}</h3>
                  <p>
                    {fmt(preview.start, data.profile.timezone)} ·{" "}
                    {preview.totalMinutes} min
                  </p>
                  <span className="tag">
                    {preview.intentPreserved ? "Zachowany cel" : "Zmiana celu"}
                  </span>
                </div>
              </div>
              <p>
                Pozostałe zaakceptowane pozycje i chroniony odpoczynek pozostają
                w planie.
              </p>
              <Timeline
                data={data}
                days={7}
                preview={preview}
                planId={plan?.id}
              />
              <div className="button-row">
                <Button
                  className="primary"
                  isDisabled={saving}
                  onPress={() => void accept("activity", preview)}
                >
                  Zatwierdź zmianę
                </Button>
                <Button className="secondary" onPress={() => setPreview(null)}>
                  Wróć do wariantów
                </Button>
                <Button className="text-button" onPress={() => void reject()}>
                  Odrzuć podgląd
                </Button>
              </div>
            </>
          ) : (
            <>
              <div className="form-grid">
                <Field label="Co się zmieniło?">
                  <select
                    value={obstacle}
                    onChange={(e) => {
                      setObstacle(e.target.value);
                      if (e.target.value === "Odpoczynek") setRest(true);
                    }}
                  >
                    {[
                      "Mniej czasu",
                      "Inne miejsce",
                      "Brak sprzętu",
                      "Samopoczucie",
                      "Odpoczynek",
                      "Zmiana celu",
                    ].map((x) => (
                      <option key={x}>{x}</option>
                    ))}
                  </select>
                </Field>
                {obstacle === "Mniej czasu" && (
                  <Field label="Ile minut masz teraz?">
                    <input
                      type="number"
                      min={1}
                      max={1440}
                      value={minutes}
                      onChange={(e) =>
                        setMinutes(Math.max(1, Number(e.target.value)))
                      }
                    />
                  </Field>
                )}
                <Field label="Co chcesz zachować?">
                  <select
                    value={intentId}
                    onChange={(e) => setIntentId(e.target.value)}
                  >
                    {data.intents.map((i) => (
                      <option value={i.id} key={i.id}>
                        {i.label}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              {["Inne miejsce", "Brak sprzętu"].includes(obstacle) && (
                <p className="caption">
                  Po zapisaniu decyzji dostępność miejsca i sprzętu obowiązuje
                  kolejne naprawy, dopóki jej nie zmienisz w Moim tygodniu.
                </p>
              )}
              {["Inne miejsce", "Brak sprzętu"].includes(obstacle) && (
                <div className="form-grid">
                  {data.resources.map((r) => (
                    <Field key={r.id} label={r.label}>
                      <select
                        value={
                          answers[`resource:${r.id}`] === undefined
                            ? "stored"
                            : String(answers[`resource:${r.id}`])
                        }
                        onChange={(e) => {
                          const next = { ...answers };
                          if (e.target.value === "stored")
                            delete next[`resource:${r.id}`];
                          else
                            next[`resource:${r.id}`] =
                              e.target.value === "true"
                                ? true
                                : e.target.value === "false"
                                  ? false
                                  : "skip";
                          setAnswers(next);
                        }}
                      >
                        <option value="stored">
                          Zapisane:{" "}
                          {r.status === "available"
                            ? "dostępne"
                            : r.status === "unavailable"
                              ? "niedostępne"
                              : "nie wiadomo"}
                        </option>
                        <option value="true">Dostępne</option>
                        <option value="false">Niedostępne</option>
                        <option value="skip">Nie wiem</option>
                      </select>
                    </Field>
                  ))}
                </div>
              )}
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={rest}
                  onChange={(e) => setRest(e.target.checked)}
                />{" "}
                Dzisiaj odpoczywam. Nie proponuj mi dziś aktywności.
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={allowChange}
                  onChange={(e) => setAllowChange(e.target.checked)}
                />{" "}
                Zgadzam się porównać również wariant zmieniający cel.
              </label>
              {result?.conflicts.length ? (
                <div className="conflict">
                  <SlidersHorizontal size={20} />
                  <div>
                    <strong>Obecny plan wymaga zmiany</strong>
                    {result.conflicts.map((r, i) => (
                      <p key={i}>{r.message}</p>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="caption">
                  Porównujemy pełny czas, dostępność i Twoje ograniczenia.
                </p>
              )}
              {result?.question && (
                <div className="question">
                  <h3>{result.question.text}</h3>
                  <div className="button-row">
                    {result.question.options.map((o) => (
                      <Button
                        className="secondary"
                        key={String(o.value)}
                        onPress={() =>
                          setAnswers({
                            ...answers,
                            [result.question!.id]: o.value,
                          })
                        }
                      >
                        {o.label}
                      </Button>
                    ))}
                    <Button
                      className="text-button"
                      onPress={() =>
                        setAnswers({
                          ...answers,
                          [result.question!.id]: "skip",
                        })
                      }
                    >
                      Pomiń
                    </Button>
                  </div>
                </div>
              )}
              {!result ? (
                <p role="status">
                  <RefreshCw size={16} /> Sprawdzam dostępne warianty…
                </p>
              ) : result.candidates.length === 0 ? (
                <Empty>
                  Nie mam potwierdzonego wariantu przy tych danych. Możesz
                  uzupełnić informacje, odpocząć albo odłożyć decyzję.
                </Empty>
              ) : (
                <div className="candidates">
                  {result.candidates.map((c, i) => (
                    <article
                      key={c.id}
                      className={`candidate ${i === 0 ? "preferred" : ""}`}
                    >
                      <div className="section-top">
                        <span className="tag">
                          {c.intentPreserved
                            ? "Zachowujesz cel"
                            : "Zmiana celu"}
                        </span>
                        <span className="caption">
                          {c.totalMinutes} min łącznie
                        </span>
                      </div>
                      <h3>{c.name}</h3>
                      <p>{fmt(c.start, data.profile.timezone)}</p>
                      <p className="caption">
                        Aktywność: {c.durationMinutes} min · przygotowanie:{" "}
                        {c.preparationMinutes} min · dojazd: {c.travelMinutes}{" "}
                        min
                      </p>
                      <p>
                        Różnica długości: {c.changes.durationDeltaMinutes} min.
                        Przesunięcie: {c.changes.startShiftMinutes} min.
                      </p>
                      <details>
                        <summary>Dlaczego ten wariant?</summary>
                        {c.reasons.map((r, i) => (
                          <p className="caption" key={i}>
                            {r.message}{" "}
                            <span>
                              Źródła: {r.evidenceIds.join(", ") || "Twój wpis"}
                            </span>
                          </p>
                        ))}
                      </details>
                      <Button
                        className={i === 0 ? "primary full" : "secondary full"}
                        onPress={() => setPreview(c)}
                      >
                        Zobacz zmianę <ArrowRight size={17} />
                      </Button>
                    </article>
                  ))}
                </div>
              )}
              <div className="rest-actions">
                <Button
                  className="secondary"
                  isDisabled={!result || saving}
                  onPress={() => void accept("rest")}
                >
                  <Leaf size={18} /> Wybieram odpoczynek
                </Button>
                <Button
                  className="secondary"
                  isDisabled={!result || saving}
                  onPress={() => void accept("defer")}
                >
                  Odkładam decyzję
                </Button>
              </div>
            </>
          )}
        </DialogBox>
      )}
    </>
  );
}
