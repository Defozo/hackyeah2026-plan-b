import { lazy, Suspense, useState } from "react";
import { DateTime } from "luxon";
import { Download, Search, Phone, Plus, Check, FileText } from "lucide-react";
import { buildCarePacket, type CarePacket } from "@planb/domain";
import type { ViewProps } from "./App";
import { Button, DialogBox, Field } from "./components";
import { download, errorText, fmt, now, uid } from "./utils";
import AgreementForm from "./AgreementForm";
import { capabilities, postApi } from "./api";
import type { CareQueue, CareResult } from "../../api/nfz";
const Voice = lazy(() => import("./Voice"));
export default function Care(props: ViewProps) {
  const { data, update, notify } = props;
  const [editingId, setEditingId] = useState<string | undefined>();
  const [days, setDays] = useState(28),
    [goal, setGoal] = useState(""),
    [questions, setQuestions] = useState(""),
    [selected, setSelected] = useState<string[]>([]),
    [packet, setPacket] = useState<CarePacket | null>(null),
    [packetRows, setPacketRows] = useState<
      { id: string; text: string; source: string }[]
    >([]),
    [agreement, setAgreement] = useState(false),
    [benefit, setBenefit] = useState(""),
    [locality, setLocality] = useState("Kraków"),
    [category, setCategory] = useState(""),
    [benefits, setBenefits] = useState<{ id: string; name: string }[]>([]),
    [nfz, setNfz] = useState<CareResult<CareQueue> | null>(null),
    [nfzError, setNfzError] = useState(""),
    [loading, setLoading] = useState(false),
    [aiPreview, setAiPreview] = useState(false),
    [aiConsent, setAiConsent] = useState(false),
    [aiBusy, setAiBusy] = useState(false),
    [aiResult, setAiResult] = useState<{
      mode: string;
      facts: { id: string; text: string }[];
      ordered: string[];
    } | null>(null);
  const start = DateTime.now()
      .setZone(data.profile.timezone)
      .minus({ days: days - 1 })
      .startOf("day")
      .toUTC()
      .toISO()!,
    end = DateTime.now()
      .setZone(data.profile.timezone)
      .plus({ days: 1 })
      .startOf("day")
      .toUTC()
      .toISO()!;
  const observations = data.observations.filter(
      (o) =>
        o.status === "confirmed" &&
        o.start < end &&
        (o.start === o.end ? o.start >= start : o.end > start),
    ),
    facts = data.documentFacts.filter((f) => f.status === "confirmed"),
    decisions = data.decisions.filter(
      (d) => d.createdAt >= start && d.createdAt < end,
    );
  const toggle = (id: string) =>
    setSelected(
      selected.includes(id)
        ? selected.filter((x) => x !== id)
        : [...selected, id],
    );
  async function previewPacket() {
    try {
      const p = buildCarePacket(data, {
        start,
        end,
        goal,
        questions: questions.split("\n").filter(Boolean),
        observationIds: selected.filter((id) =>
          observations.some((o) => o.id === id),
        ),
        documentFactIds: selected.filter((id) =>
          facts.some((f) => f.id === id),
        ),
        decisionIds: selected.filter((id) =>
          decisions.some((d) => d.id === id),
        ),
        now: now(),
      });
      const { packetLines } = await import("./report");
      setPacketRows(packetLines(data, p));
      setPacket(p);
    } catch (e) {
      notify(errorText(e));
    }
  }
  async function exportPacket(kind: "html" | "pdf") {
    if (!packet) return;
    try {
      const sourceIds = [
        ...new Set([
          ...data.observations
            .filter((o) => packet.observationIds.includes(o.id))
            .map((o) => o.sourceId),
          ...data.documentFacts
            .filter((f) => packet.documentFactIds.includes(f.id))
            .map((f) => f.sourceId),
          ...data.decisions
            .filter((d) => packet.decisionIds.includes(d.id))
            .flatMap((d) => d.sourceIds),
        ]),
      ];
      const p = { ...packet, sourceIds, approved: true };
      const report = await import("./report");
      const content =
        kind === "pdf"
          ? await report.buildPdf(data, p)
          : report.buildHtml(data, p);
      download(
        `plan-b-konsultacja.${kind}`,
        content,
        kind === "html" ? "text/html" : "application/pdf",
      );
      await update({
        ...data,
        carePackets: [...data.carePackets.filter((x) => x.id !== p.id), p],
        exports: [
          ...data.exports,
          {
            id: uid(),
            kind,
            createdAt: now(),
            sourceIds: p.sourceIds,
            status: "downloaded",
          },
        ],
      });
      notify(
        `Raport ${kind.toUpperCase()} pobrany. Samodzielnie zdecyduj, komu go udostępnić.`,
      );
    } catch (e) {
      notify(errorText(e));
    }
  }
  async function search(page = 1) {
    if (!category || !benefit.trim() || !locality.trim()) {
      setNfzError("Wybierz świadczenie, miejscowość i kategorię przypadku.");
      return;
    }
    setLoading(true);
    setNfzError("");
    setNfz(null);
    try {
      const q = new URLSearchParams({
        benefit,
        locality,
        case: category,
        page: String(page),
      });
      const r = await fetch(`/api/care/queues?${q}`, {
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok)
        throw Error(
          "Nie udało się pobrać placówek. Twoje filtry pozostają zachowane.",
        );
      setNfz(await r.json());
    } catch (e) {
      setNfzError(errorText(e));
    } finally {
      setLoading(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">ŁATWIEJ ZACZĄĆ ROZMOWĘ</p>
          <h1>
            Przed wizytą<span>.</span>
          </h1>
          <p>
            Wybierz istotne fakty. Zapisz pytania. Zabierz ze sobą własną
            historię.
          </p>
        </div>
        <Button
          className="secondary"
          onPress={() => {
            setEditingId(undefined);
            setAgreement(true);
          }}
        >
          <Plus size={17} /> Ustalenia po konsultacji
        </Button>
      </div>
      <div className="care-grid">
        <section className="panel">
          <h2>1. Co chcesz omówić?</h2>
          <Field label="Cel rozmowy">
            <textarea
              placeholder="Np. jak ułożyć aktywność przy nocnych zmianach"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
            />
          </Field>
          <Field label="Pytania (jedno w wierszu)">
            <textarea
              value={questions}
              onChange={(e) => setQuestions(e.target.value)}
              placeholder="Co warto ustalić, zanim zmienię mój plan?"
            />
          </Field>
          <Suspense fallback={null}>
            <Voice
              {...props}
              onText={(text) =>
                setQuestions(questions ? `${questions}\n${text}` : text)
              }
            />
          </Suspense>
          <Field label="Okres raportu">
            <select
              value={days}
              onChange={(e) => {
                setDays(Number(e.target.value));
                setSelected([]);
              }}
            >
              <option value={7}>Ostatnie 7 dni</option>
              <option value={28}>Ostatnie 28 dni</option>
            </select>
          </Field>
          <p className="caption">
            Raport zawiera tylko zaznaczone elementy. Każdy zachowuje swoje
            źródło.
          </p>
        </section>
        <section className="panel">
          <h2>2. Wybierz fakty do raportu</h2>
          <div className="selection-list">
            {facts.map((f) => (
              <label className="checkbox" key={f.id}>
                <input
                  type="checkbox"
                  checked={selected.includes(f.id)}
                  onChange={() => toggle(f.id)}
                />
                <span>
                  {f.value}
                  <small>
                    Dokument potwierdzony · strona {f.page} ·{" "}
                    {data.sources.find((s) => s.id === f.sourceId)?.name}
                  </small>
                </span>
              </label>
            ))}
            {observations.map((o) => (
              <label key={o.id} className="checkbox">
                <input
                  type="checkbox"
                  checked={selected.includes(o.id)}
                  onChange={() => toggle(o.id)}
                />
                <span>
                  {o.metric}: {o.value} {o.unit}
                  <small>
                    Pomiar / wpis · {fmt(o.start)} ·{" "}
                    {data.sources.find((s) => s.id === o.sourceId)?.name}
                  </small>
                </span>
              </label>
            ))}
            {decisions.map((d) => (
              <label key={d.id} className="checkbox">
                <input
                  type="checkbox"
                  checked={selected.includes(d.id)}
                  onChange={() => toggle(d.id)}
                />
                <span>
                  {d.kind === "rest"
                    ? "Odpoczynek"
                    : d.kind === "defer"
                      ? "Decyzja odłożona"
                      : (d.candidate?.name ?? "Źródło usunięto")}
                  <small>
                    Samoopis · {fmt(d.createdAt)} · {d.obstacle}
                  </small>
                </span>
              </label>
            ))}
          </div>
          <div className="button-row">
            <Button className="primary" onPress={() => void previewPacket()}>
              <FileText size={17} /> Podgląd karty konsultacji
            </Button>
            <Button
              className="text-button"
              onPress={() => {
                setAiConsent(false);
                setAiResult(null);
                setAiPreview(true);
              }}
            >
              Pomoc w uporządkowaniu
            </Button>
          </div>
        </section>
      </div>
      <section className="panel nfz">
        <div className="section-top">
          <div>
            <h2>Znajdź kontakt w NFZ</h2>
            <p>
              Wyszukaj świadczenie, które znasz. Aplikacja nie dobiera
              specjalizacji na podstawie objawów.
            </p>
          </div>
          <span className="tag">Publiczne dane NFZ</span>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void search();
          }}
        >
          <div className="form-grid nfz-fields">
            <Field label="Świadczenie">
              <input
                required
                value={benefit}
                list="benefits"
                onChange={(e) => setBenefit(e.target.value)}
                placeholder="Np. PORADNIA REHABILITACYJNA"
              />
              <datalist id="benefits">
                {benefits.map((b) => (
                  <option key={b.id} value={b.name} />
                ))}
              </datalist>
            </Field>
            <Field label="Miejscowość">
              <input
                required
                value={locality}
                onChange={(e) => setLocality(e.target.value)}
              />
            </Field>
            <Field label="Kategoria przypadku">
              <select
                required
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              >
                <option value="">Wybierz według posiadanej informacji</option>
                <option value="1">Stabilny</option>
                <option value="2">Pilny</option>
              </select>
            </Field>
          </div>
          <div className="button-row">
            <Button type="submit" className="primary" isDisabled={loading}>
              <Search size={17} />
              {loading ? "Wyszukuję…" : "Szukaj placówek"}
            </Button>
            <Button
              className="secondary"
              onPress={async () => {
                try {
                  const r = await fetch(
                    `/api/care/benefits?q=${encodeURIComponent(benefit)}`,
                    { signal: AbortSignal.timeout(15000) },
                  );
                  if (!r.ok)
                    throw Error("Nie udało się pobrać słownika świadczeń.");
                  const b = await r.json();
                  setBenefits(b.items);
                  notify(
                    `Wczytano ${b.items.length} nazw świadczeń. Wybierz nazwę w polu świadczenia.`,
                  );
                } catch (e) {
                  setNfzError(errorText(e));
                }
              }}
            >
              Podpowiedz nazwy świadczeń
            </Button>
            <a
              href="https://terminyleczenia.nfz.gov.pl/"
              target="_blank"
              rel="noreferrer"
            >
              Oficjalna wyszukiwarka NFZ
            </a>
          </div>
        </form>
        {nfzError && (
          <p role="alert" className="error-text">
            {nfzError}
          </p>
        )}
        {nfz && (
          <>
            <p className="caption">
              {nfz.source} · pobrano {fmt(nfz.fetchedAt)} ·{" "}
              {nfz.cache === "live"
                ? "odczyt na żywo"
                : nfz.cache === "fresh"
                  ? "aktualny zapis podręczny"
                  : "STARY ZAPIS, nie udało się odświeżyć"}
            </p>
            {nfz.warning && <p className="warning-text">{nfz.warning}</p>}
            {nfz.items.length === 0 ? (
              <p>Brak wyników dla podanych filtrów.</p>
            ) : (
              nfz.items.map((p) => (
                <article className="provider" key={p.id}>
                  <div>
                    <h3>{p.name}</h3>
                    <p>
                      {p.address}, {p.locality}
                    </p>
                    <p>
                      Prognozowany czas udzielenia świadczenia:{" "}
                      <strong>
                        {p.applicable === false
                          ? "Nie dotyczy"
                          : (p.pcus ?? "Brak informacji")}
                      </strong>
                    </p>
                    <small>
                      Aktualność źródła: {p.situationAsAt ?? "brak daty"}.
                      Prognoza nie jest terminem rezerwacji.
                    </small>
                    <details>
                      <summary>Dostępność placówki</summary>
                      {Object.entries(p.accessibility).map(([key, value]) => (
                        <p key={key}>
                          {{
                            toilet: "Toaleta",
                            ramp: "Podjazd",
                            "car-park": "Parking",
                            elevator: "Winda",
                            "automatic-door": "Drzwi automatyczne",
                            wheelchairs: "Wózki",
                            corridors: "Korytarze",
                          }[key] ?? key}
                          :{" "}
                          {value === null
                            ? "brak informacji"
                            : value
                              ? "tak"
                              : "nie"}
                        </p>
                      ))}
                    </details>
                  </div>
                  {p.phone ? (
                    <a
                      className="button secondary"
                      href={`tel:${p.phone.replace(/[^+0-9]/g, "")}`}
                    >
                      <Phone size={16} />
                      {p.phone}
                    </a>
                  ) : (
                    <span>Brak numeru telefonu</span>
                  )}
                </article>
              ))
            )}
            <div className="button-row">
              <Button
                className="secondary"
                isDisabled={nfz.page <= 1 || loading}
                onPress={() => void search(nfz.page - 1)}
              >
                Poprzednia strona
              </Button>
              <span>
                Strona {nfz.page} · wyników {nfz.total ?? "brak informacji"}
              </span>
              <Button
                className="secondary"
                isDisabled={!nfz.hasNext || loading}
                onPress={() => void search(nfz.page + 1)}
              >
                Następna strona
              </Button>
            </div>
          </>
        )}
      </section>
      <section className="panel">
        <h2>Zapisane ustalenia</h2>
        {data.constraints.length === 0 ? (
          <p>
            Po konsultacji możesz zapisać ustalenie i osobno zatwierdzić jego
            wpływ na plan.
          </p>
        ) : (
          data.constraints.map((c) => (
            <div className="fact-row" key={c.id}>
              <div>
                <span className="tag">
                  {c.mappingState === "confirmed"
                    ? "Odwzorowanie zatwierdzone"
                    : "Wymaga wyjaśnienia"}
                </span>
                <p>{c.sourceText}</p>
                <small>
                  {c.consultationDate} ·{" "}
                  {data.sources.find((s) => s.id === c.sourceId)?.name} ·{" "}
                  {c.validUntil
                    ? `Obowiązuje do ${fmt(c.validUntil)}; potem wymaga przeglądu`
                    : "Bez daty zakończenia"}
                </small>
              </div>
              <Button
                className="text-button"
                onPress={() => {
                  setEditingId(c.id);
                  setAgreement(true);
                }}
              >
                Przygotuj doprecyzowanie
              </Button>
            </div>
          ))
        )}
      </section>
      {packet && (
        <DialogBox
          title="Sprawdź kartę konsultacji"
          onClose={() => setPacket(null)}
        >
          {packet.synthetic && <p className="tag">Dane syntetyczne</p>}
          <h3>Cel rozmowy</h3>
          <p>{packet.goal || "Nie podano"}</p>
          <h3>Wybrane fakty i źródła</h3>
          {packetRows.map((l) => (
            <div className="fact-row" key={l.id}>
              <div>
                <p>{l.text}</p>
                <small>{l.source}</small>
              </div>
              <Button
                className="text-button"
                onPress={() => {
                  setPacket({
                    ...packet,
                    observationIds: packet.observationIds.filter(
                      (x) => x !== l.id,
                    ),
                    documentFactIds: packet.documentFactIds.filter(
                      (x) => x !== l.id,
                    ),
                    decisionIds: packet.decisionIds.filter((x) => x !== l.id),
                  });
                  setPacketRows(packetRows.filter((x) => x.id !== l.id));
                }}
              >
                Usuń z raportu
              </Button>
            </div>
          ))}
          <h3>Moje pytania</h3>
          <ol>
            {packet.questions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ol>
          <div className="button-row">
            <Button
              className="primary"
              onPress={() => void exportPacket("pdf")}
            >
              <Download size={17} /> Zatwierdź i pobierz PDF
            </Button>
            <Button
              className="secondary"
              onPress={() => void exportPacket("html")}
            >
              Pobierz dostępny HTML
            </Button>
          </div>
        </DialogBox>
      )}
      {agreement && (
        <AgreementForm
          {...props}
          editingId={editingId}
          onClose={() => setAgreement(false)}
        />
      )}
      {aiPreview && (
        <DialogBox
          title="Pomoc językowa: najpierw zakres"
          onClose={() => setAiPreview(false)}
        >
          <p>
            Groq może zaproponować kolejność potwierdzonych faktów. Liczby i
            ograniczenia pozostają dokładnie takie jak w źródłach.
          </p>
          {data.profile.mode === "demo" ? (
            <p>
              Wyślemy gotowy syntetyczny przykład „Zmiana grafiku”, bez Twoich
              własnych wpisów.
            </p>
          ) : (
            facts
              .filter((f) => selected.includes(f.id))
              .map((f) => <p key={f.id}>{f.value}</p>)
          )}
          <p className="caption">
            Przed wysyłką usuń zbędne nazwiska i identyfikatory w źródle.
            Niezaznaczone elementy nie są wysyłane.
          </p>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={aiConsent}
              onChange={(e) => setAiConsent(e.target.checked)}
            />{" "}
            Zgadzam się przekazać wybrany zakres do Groq w celu uporządkowania
            faktów.
          </label>
          <Button
            className="primary"
            isDisabled={!aiConsent || aiBusy}
            onPress={async () => {
              setAiBusy(true);
              try {
                const caps = await capabilities();
                const chosen = facts.filter((f) => selected.includes(f.id));
                if (
                  data.profile.mode === "personal" &&
                  chosen.some((f) => {
                    const s = data.sources.find((s) => s.id === f.sourceId);
                    return !s?.usageVerified || !s.aiAllowed;
                  })
                )
                  throw Error(
                    "Te źródła nie mają zweryfikowanej zgody na użycie w AI. Raport szablonowy pozostaje dostępny.",
                  );
                await update({
                  ...data,
                  consents: [
                    ...data.consents,
                    {
                      id: uid(),
                      provider: "Groq",
                      purpose: "text",
                      scope:
                        data.profile.mode === "demo"
                          ? ["shift-change"]
                          : chosen.map((f) => f.id),
                      grantedAt: now(),
                    },
                  ],
                });
                const result = await postApi(
                  "text-draft",
                  {
                    consent: {
                      provider: "groq",
                      purpose: "text-draft",
                      approved: true,
                    },
                    ...(data.profile.mode === "demo"
                      ? { syntheticId: "shift-change" }
                      : {
                          purpose: "care-packet",
                          facts: chosen.map((f) => ({
                            id: f.id,
                            text: f.value,
                            sourceId: f.sourceId,
                            status: "confirmed",
                            allowedForAi: true,
                          })),
                        }),
                  },
                  caps.csrfToken,
                );
                notify(
                  result.mode === "ai"
                    ? "Groq zwrócił propozycję opartą na wskazanych źródłach. Sprawdź podgląd raportu."
                    : "Zastosowano lokalny układ szablonowy. Raport pozostaje dostępny.",
                );
                setAiResult({
                  mode: result.mode,
                  facts: result.facts,
                  ordered: result.draft?.orderedFactIds ?? [],
                });
                if (
                  data.profile.mode === "personal" &&
                  result.draft?.orderedFactIds
                )
                  setSelected([
                    ...result.draft.orderedFactIds,
                    ...selected.filter(
                      (x) => !result.draft.orderedFactIds.includes(x),
                    ),
                  ]);
              } catch (e) {
                const localFacts = facts
                  .filter((f) => selected.includes(f.id))
                  .map((f) => ({ id: f.id, text: f.value }));
                setAiResult({
                  mode: "template",
                  facts: localFacts,
                  ordered: localFacts.map((f) => f.id),
                });
                notify(
                  `${errorText(e)} Użyj lokalnego układu raportu poniżej.`,
                );
              } finally {
                setAiBusy(false);
              }
            }}
          >
            {aiBusy ? "Porządkuję…" : "Zatwierdź zakres i wyślij"}
          </Button>
          {aiResult && (
            <section className="panel">
              <h3>
                {aiResult.mode === "ai"
                  ? "Proponowana kolejność"
                  : "Układ szablonowy"}
              </h3>
              <ol>
                {aiResult.ordered.map((id) => (
                  <li key={id}>
                    {aiResult.facts.find((f) => f.id === id)?.text}
                  </li>
                ))}
              </ol>
              <p className="caption">
                Treść została odczytana z wybranych źródeł, bez generowania
                nowych liczb lub zaleceń.
              </p>
            </section>
          )}
          <Button
            className="text-button"
            onPress={() => {
              setAiPreview(false);
              void previewPacket();
            }}
          >
            Użyj raportu bez AI
          </Button>
        </DialogBox>
      )}
    </>
  );
}
