import { useEffect, useRef, useState } from "react";
import {
  Download,
  FileUp,
  LockKeyhole,
  Trash2,
  Database,
  Check,
} from "lucide-react";
import {
  startImport,
  cancelAllImports,
  type ImportPreview,
  type CSVField,
  inspectCSV,
  exportCalendar,
  exportCSV,
  reviewFact,
  parsePolishNumber,
  normalizeUnit,
  instantFromLocal,
} from "@planb/importers";
import { correctSource } from "@planb/domain";
import type { ViewProps } from "./App";
import { type Vault, fromBase64, toBase64 } from "./vault";
import { Button, DialogBox, Field } from "./components";
import { download, errorText, fmt, now, uid } from "./utils";
import {
  persistImport,
  getImportReplacement,
  removeImportedSource,
  resolveObservationConflicts,
  reviewOverlappingSources,
  type SourceConflict,
} from "./import-state";

function ConflictReview({
  conflicts,
  choices,
  onChange,
}: {
  conflicts: SourceConflict[];
  choices: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}) {
  return (
    <>
      {conflicts.map((c) => (
        <Field
          key={c.id}
          label={`Źródło nadrzędne: ${c.metric} (${fmt(c.start)})`}
          hint="W tym nakładającym się zakresie użyjemy pomiarów jednego źródła. Pozostałe zachowamy do ponownego wyboru, bez sumowania."
        >
          <select
            value={choices[c.id] ?? c.selected ?? ""}
            onChange={(e) => onChange({ ...choices, [c.id]: e.target.value })}
          >
            <option value="">Wybierz źródło</option>
            {c.sources.map((s) => (
              <option key={s.key} value={s.key}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
      ))}
    </>
  );
}
export default function DataView({
  data,
  update,
  notify,
  vault,
  lock,
  resetDemo,
}: ViewProps & {
  vault: Vault;
  lock: () => Promise<void>;
  resetDemo: () => Promise<void>;
}) {
  const [preview, setPreview] = useState<ImportPreview | null>(null),
    [progress, setProgress] = useState(""),
    [busy, setBusy] = useState(false);
  const [replaceReviewedBatch, setReplaceReviewedBatch] = useState(false);
  const [calendarKind, setCalendarKind] = useState<"work" | "rest" | "busy">(
      "work",
    ),
    [timezone, setTimezone] = useState(data.profile.timezone),
    [sourceId, setSourceId] = useState("");
  const [horizonStart, setHorizonStart] = useState(
      new Date().toISOString().slice(0, 10),
    ),
    [horizonEnd, setHorizonEnd] = useState(
      new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10),
    );
  const [phrase, setPhrase] = useState(""),
    [newPhrase, setNewPhrase] = useState(""),
    [confirmDelete, setConfirmDelete] = useState(false),
    [sourceToDelete, setSourceToDelete] = useState<string | null>(null);
  const [editFact, setEditFact] = useState<string | null>(null),
    [value, setValue] = useState(""),
    [factUnit, setFactUnit] = useState("");
  const [choices, setChoices] = useState<Record<string, string>>({}),
    [storedChoices, setStoredChoices] = useState<Record<string, string>>({});
  const [mapping, setMapping] = useState<Partial<Record<CSVField, string>>>({}),
    [headers, setHeaders] = useState<string[]>([]),
    [sample, setSample] = useState<string[][]>([]),
    [delimiter, setDelimiter] = useState(""),
    [file, setFile] = useState<File | null>(null);
  const [usageSource, setUsageSource] = useState<string | null>(null),
    [usageVerified, setUsageVerified] = useState(false),
    [aiAllowed, setAIAllowed] = useState(false);
  const [manualMetric, setManualMetric] = useState("energy"),
    [manualValue, setManualValue] = useState(""),
    [manualUnit, setManualUnit] = useState("score"),
    [manualStart, setManualStart] = useState(""),
    [manualEnd, setManualEnd] = useState("");
  const [editObservation, setEditObservation] = useState<string | null>(null),
    [observationValue, setObservationValue] = useState(""),
    [observationUnit, setObservationUnit] = useState("");
  const cancel = useRef<(() => void) | null>(null),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      cancel.current?.();
    };
  }, []);
  const previewReview = (() => {
    try {
      return preview
        ? { ...reviewOverlappingSources(data, preview), error: "" }
        : null;
    } catch (error) {
      return { records: [], sourceConflicts: [], error: errorText(error) };
    }
  })();
  const existingReview = reviewOverlappingSources(data);
  const replacement = preview ? getImportReplacement(data, preview) : null;
  const selectedFact = data.documentFacts.find((f) => f.id === editFact);
  const selectedPage =
    selectedFact &&
    data.documentPages?.find(
      (p) =>
        p.sourceId === selectedFact.sourceId && p.page === selectedFact.page,
    );
  const selectedImage = data.attachments.find(
    (a) => a.id === selectedPage?.imageAttachmentId,
  );
  const selectedMetadata = data.documentFactMetadata?.find(
    (f) => f.id === editFact,
  );
  async function inspectFile(f: File, separator = delimiter) {
    if (f.size > 10 * 1024 * 1024)
      throw Error("Plik przekracza limit 10 MB. Podziel go na mniejsze pliki.");
    const result = inspectCSV(await f.text(), separator || undefined);
    setHeaders(result.headers);
    setSample(result.sample);
    setMapping({});
  }
  async function importFile(f: File) {
    setBusy(true);
    setProgress("Odczyt pliku");
    setPreview(null);
    setReplaceReviewedBatch(false);
    setChoices({});
    try {
      if (
        sourceId &&
        data.sources.find((s) => s.id === sourceId)?.kind !==
          f.name.split(".").pop()?.toLowerCase()
      )
        throw Error(
          "Aktualizacja musi mieć taki sam format jak wybrane źródło. Zmień wybór źródła albo plik.",
        );
      const task = startImport(f, {
        timezone,
        calendarKind,
        sourceId: sourceId || undefined,
        csvMapping: mapping,
        delimiter: delimiter || undefined,
        horizonStart: instantFromLocal(horizonStart, timezone),
        horizonEnd: instantFromLocal(horizonEnd, timezone),
        onProgress: (p) => {
          if (alive.current)
            setProgress(`${p.stage}: ${Math.round(p.progress * 100)}%`);
        },
      });
      cancel.current = task.cancel;
      const result = await task.promise;
      if (alive.current) setPreview(result);
    } catch (error) {
      if (alive.current)
        notify(
          error instanceof Error && error.name === "AbortError"
            ? "Import anulowany. Wcześniejsze dane pozostają bez zmian."
            : errorText(error),
        );
    } finally {
      if (alive.current) setBusy(false);
      cancel.current = null;
    }
  }
  async function exportFile(kind: "backup" | "ics" | "csv") {
    try {
      let text = "";
      if (kind === "backup") text = await vault.export();
      else if (kind === "ics")
        text = exportCalendar(
          data.plans
            .filter((p) => p.status === "accepted")
            .map((p) => ({
              uid: p.id,
              sequence: p.revision,
              start: p.start,
              end: p.end,
              title:
                data.activities
                  .flatMap((a) => a.variants)
                  .find((v) => v.id === p.variantId)?.name ?? "Moja aktywność",
              reminderMinutes: data.reminders ? 15 : undefined,
              quietWindows: data.protectedWindows,
            })),
        );
      else
        text = exportCSV(
          data.observations
            .filter((o) => typeof o.value === "number")
            .map((o) => ({
              id: o.id,
              sourceId: o.sourceId,
              sourceName:
                data.sources.find((s) => s.id === o.sourceId)?.name ??
                o.sourceId,
              externalId: o.externalId ?? o.id,
              version: o.revision,
              metric: o.metric,
              start: o.start,
              end: o.end,
              timezone: o.timezone ?? data.profile.timezone,
              originalLocal: o.start,
              value: Number(o.value),
              unit: o.unit,
              originalValue: String(o.value),
              originalUnit: o.unit,
              status: o.status,
            })),
        );
      download(
        `plan-b-${kind}.${kind === "backup" ? "json" : kind}`,
        text,
        kind === "ics"
          ? "text/calendar"
          : kind === "csv"
            ? "text/csv"
            : "application/json",
      );
      await update({
        ...data,
        exports: [
          ...data.exports,
          {
            id: uid(),
            kind,
            createdAt: now(),
            sourceIds: data.sources
              .filter((s) => s.status !== "deleted")
              .map((s) => s.id),
            status: "downloaded",
          },
        ],
      });
      notify(
        kind === "ics"
          ? "Plik ICS pobrany. Samodzielnie dodaj lub zaktualizuj go w kalendarzu. Nie potwierdzamy przyjęcia przez kalendarz."
          : "Plik został pobrany.",
      );
    } catch (error) {
      notify(errorText(error));
    }
  }
  function closePreview() {
    setPreview(null);
    setChoices({});
    notify("Import anulowany. Wcześniejsze dane pozostają bez zmian.");
  }
  async function saveManual() {
    try {
      if (!manualMetric.trim() || !manualUnit.trim() || !manualStart)
        throw Error("Uzupełnij miarę, wartość, jednostkę i czas.");
      const normalized = normalizeUnit(
          manualMetric.trim(),
          parsePolishNumber(manualValue),
          manualUnit,
        ),
        start = instantFromLocal(manualStart, data.profile.timezone),
        end = manualEnd
          ? instantFromLocal(manualEnd, data.profile.timezone)
          : start;
      if (Date.parse(end) < Date.parse(start))
        throw Error("Koniec pomiaru nie może poprzedzać początku.");
      const id = uid(),
        sourceId = `manual-${id}`;
      await update({
        ...data,
        revision: data.revision + 1,
        sources: [
          ...data.sources,
          {
            id: sourceId,
            kind: "manual",
            name: "Własny wpis",
            createdAt: now(),
            status: "active",
            revision: 1,
            aiAllowed: false,
            usageVerified: false,
            synthetic: data.profile.mode === "demo",
          },
        ],
        observations: [
          ...data.observations,
          {
            id,
            sourceId,
            metric: manualMetric.trim(),
            ...normalized,
            quality:
              normalized.unit !== manualUnit.trim()
                ? `Jednostka źródłowa: ${manualValue} ${manualUnit.trim()}`
                : undefined,
            start,
            end,
            timezone: data.profile.timezone,
            originalLocalStart: manualStart,
            status: "confirmed",
            revision: 1,
          },
        ],
      });
      setManualValue("");
      notify(
        "Własna obserwacja zapisana. To samoopis, bez interpretacji medycznej.",
      );
    } catch (error) {
      notify(errorText(error));
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">TY DECYDUJESZ O SWOICH DANYCH</p>
          <h1>
            Moje dane<span>.</span>
          </h1>
          <p>Źródła, potwierdzenia i bezpieczna kopia Twojego zapisu.</p>
        </div>
        <span className="tag">
          <LockKeyhole size={15} /> Lokalny sejf
        </span>
      </div>
      <div className="data-grid">
        <section className="panel">
          <h2>
            <FileUp size={20} /> Dodaj źródło
          </h2>
          <p>
            ICS, CSV, FIT, PDF, JPG lub PNG. Do 10 MB, PDF do 20 stron.
            Dokumenty i OCR są przetwarzane na urządzeniu.
          </p>
          <Field
            label="Strefa czasu importu"
            hint="Dotyczy czasu bez strefy i zdarzeń całodniowych. Wybierz strefę właściwą dla pliku."
          >
            <input
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
            />
          </Field>
          <Field label="Rodzaj importowanego grafiku">
            <select
              value={calendarKind}
              onChange={(e) =>
                setCalendarKind(e.target.value as typeof calendarKind)
              }
            >
              <option value="work">Praca / zmiany</option>
              <option value="rest">Chroniony odpoczynek</option>
              <option value="busy">Inny zajęty czas</option>
            </select>
          </Field>
          <details>
            <summary>Zakres kalendarza i aktualizacja źródła</summary>
            <div className="form-grid">
              <Field label="Początek zakresu ICS">
                <input
                  type="date"
                  value={horizonStart}
                  onChange={(e) => setHorizonStart(e.target.value)}
                />
              </Field>
              <Field label="Koniec zakresu ICS (wyłączny)">
                <input
                  type="date"
                  value={horizonEnd}
                  onChange={(e) => setHorizonEnd(e.target.value)}
                />
              </Field>
            </div>
            <Field
              label="Aktualizowany kalendarz lub CSV"
              hint="Wybierz istniejące źródło, gdy plik aktualizacji ma inną nazwę."
            >
              <select
                value={sourceId}
                onChange={(e) => setSourceId(e.target.value)}
              >
                <option value="">Rozpoznaj według nazwy pliku</option>
                {data.sources
                  .filter(
                    (s) =>
                      s.status !== "deleted" && ["ics", "csv"].includes(s.kind),
                  )
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </select>
            </Field>
          </details>
          <Field label="Wybierz plik">
            <input
              type="file"
              accept=".ics,.csv,.fit,.pdf,.png,.jpg,.jpeg"
              disabled={busy}
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (!f) return;
                setFile(f);
                setPreview(null);
                setChoices({});
                try {
                  if (f.name.toLowerCase().endsWith(".csv"))
                    await inspectFile(f);
                  else {
                    setHeaders([]);
                    await importFile(f);
                  }
                } catch (error) {
                  notify(errorText(error));
                }
              }}
            />
          </Field>
          {headers.length > 0 && (
            <>
              <details open>
                <summary>Mapowanie kolumn CSV</summary>
                <Field label="Separator CSV">
                  <select
                    value={delimiter}
                    onChange={async (e) => {
                      setDelimiter(e.target.value);
                      if (file)
                        try {
                          await inspectFile(file, e.target.value);
                        } catch (error) {
                          notify(errorText(error));
                        }
                    }}
                  >
                    <option value="">Rozpoznaj automatycznie</option>
                    <option value=";">Średnik</option>
                    <option value=",">Przecinek</option>
                    <option value={"\t"}>Tabulator</option>
                  </select>
                </Field>
                <div className="form-grid">
                  {(
                    [
                      "source",
                      "external_id",
                      "metric",
                      "start",
                      "end",
                      "timezone",
                      "value",
                      "unit",
                      "version",
                    ] as CSVField[]
                  ).map((k) => (
                    <Field key={k} label={k}>
                      <select
                        value={mapping[k] ?? (headers.includes(k) ? k : "")}
                        onChange={(e) =>
                          setMapping({ ...mapping, [k]: e.target.value })
                        }
                      >
                        <option value="">
                          {["metric", "start", "value", "unit"].includes(k)
                            ? "Wybierz kolumnę"
                            : "Brak kolumny (opcjonalna)"}
                        </option>
                        {headers.map((h) => (
                          <option key={h}>{h}</option>
                        ))}
                      </select>
                    </Field>
                  ))}
                </div>
                <p className="caption">
                  Polskie liczby z przecinkiem są rozpoznawane przed zapisem.
                  Pusta wartość nie jest zerem.
                </p>
                <details>
                  <summary>Pierwsze wiersze pliku</summary>
                  <pre className="source-text">
                    {[headers, ...sample]
                      .map((row) => row.join(" | "))
                      .join("\n")}
                  </pre>
                </details>
              </details>
              <Button
                className="primary"
                isDisabled={busy}
                onPress={() => file && void importFile(file)}
              >
                Pokaż podgląd CSV
              </Button>
            </>
          )}
          {busy && (
            <div role="status">
              <p>{progress}</p>
              <Button className="secondary" onPress={() => cancel.current?.()}>
                Przerwij import
              </Button>
            </div>
          )}
        </section>
        <section className="panel">
          <h2>
            <Database size={20} /> Kopia i odzyskiwanie
          </h2>
          <p>
            Fraza nie opuszcza urządzenia. Kopia zawiera zaszyfrowane dane i
            załączniki.
          </p>
          <div className="button-row">
            <Button
              className="primary"
              onPress={() => void exportFile("backup")}
            >
              <Download size={17} /> Pobierz kopię sejfu
            </Button>
            <Button
              className="secondary"
              onPress={() => void exportFile("ics")}
            >
              Eksport ICS
            </Button>
            <Button
              className="secondary"
              onPress={() => void exportFile("csv")}
            >
              Eksport CSV
            </Button>
          </div>
          <details>
            <summary>Odtwórz kopię</summary>
            <p>
              Poprawna kopia zastąpi obecny sejf. Zła fraza lub uszkodzony plik
              nie zmienią danych.
            </p>
            <Field label="Fraza kopii">
              <input
                type="password"
                autoComplete="off"
                value={phrase}
                onChange={(e) => setPhrase(e.target.value)}
              />
            </Field>
            <Field label="Plik kopii">
              <input
                type="file"
                accept=".json"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  try {
                    if (f.size > 150000000)
                      throw Error("Kopia jest zbyt duża.");
                    const restored = await vault.restore(
                      await f.text(),
                      phrase,
                    );
                    await update(restored);
                    setPhrase("");
                    notify("Kopia została odtworzona i odczytana.");
                  } catch (error) {
                    notify(errorText(error));
                  }
                }}
              />
            </Field>
          </details>
          <details>
            <summary>Zmień frazę</summary>
            <Field label="Obecna fraza">
              <input
                type="password"
                value={phrase}
                onChange={(e) => setPhrase(e.target.value)}
              />
            </Field>
            <Field label="Nowa fraza">
              <input
                type="password"
                minLength={12}
                value={newPhrase}
                onChange={(e) => setNewPhrase(e.target.value)}
              />
            </Field>
            <Button
              className="secondary"
              onPress={async () => {
                try {
                  await vault.changePhrase(phrase, newPhrase);
                  setPhrase("");
                  setNewPhrase("");
                  notify("Fraza została zmieniona. Pobierz nową kopię sejfu.");
                } catch (error) {
                  notify(errorText(error));
                }
              }}
            >
              Zmień frazę
            </Button>
          </details>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={data.reminders}
              onChange={async (e) => {
                try {
                  await update({ ...data, reminders: e.target.checked });
                } catch {
                  /* update reports the error */
                }
              }}
            />{" "}
            Przypomnienie o rezultacie przy otwieraniu aplikacji
          </label>
          <small>
            Przypomnienie jest wyciszone podczas chronionego odpoczynku.
            Rezultat zawsze możesz uzupełnić w Historii. To ustawienie dodaje
            też neutralny alarm 15 minut przed aktywnością do eksportowanego
            ICS, poza chronionym odpoczynkiem. Nie obiecujemy alarmu z
            zamkniętej aplikacji. Alarmy kalendarza wymagają samodzielnej
            aktualizacji po zmianie planu.
          </small>
        </section>
      </div>
      <section className="panel">
        <h2>Własna obserwacja</h2>
        <p>
          Możesz zapisać pomiar lub samoocenę bez pliku i urządzenia. Jednostkę
          podajesz samodzielnie.
        </p>
        <div className="form-grid">
          <Field label="Miara">
            <input
              value={manualMetric}
              onChange={(e) => setManualMetric(e.target.value)}
            />
          </Field>
          <Field label="Wartość obserwacji">
            <input
              inputMode="decimal"
              value={manualValue}
              onChange={(e) => setManualValue(e.target.value)}
            />
          </Field>
          <Field label="Jednostka obserwacji">
            <input
              value={manualUnit}
              onChange={(e) => setManualUnit(e.target.value)}
            />
          </Field>
          <Field label="Czas obserwacji">
            <input
              type="datetime-local"
              value={manualStart}
              onChange={(e) => setManualStart(e.target.value)}
            />
          </Field>
          <Field label="Koniec obserwacji (opcjonalnie)">
            <input
              type="datetime-local"
              value={manualEnd}
              onChange={(e) => setManualEnd(e.target.value)}
            />
          </Field>
        </div>
        <Button className="secondary" onPress={() => void saveManual()}>
          Zapisz obserwację
        </Button>
      </section>
      <section className="panel">
        <h2>Twoje źródła</h2>
        {data.sources
          .filter((s) => s.status !== "deleted")
          .map((s) => (
            <div className="source-row" key={s.id}>
              <div>
                <strong>{s.name}</strong>
                <small>
                  {s.kind.toUpperCase()} · {fmt(s.createdAt)} · wersja{" "}
                  {s.revision} ·{" "}
                  {s.usageVerified
                    ? s.aiAllowed
                      ? "Zasady sprawdzone, możliwa osobna zgoda AI"
                      : "Zasady sprawdzone, użycie lokalne"
                    : "Tylko lokalnie, zasady użycia niezweryfikowane"}
                </small>
              </div>
              <div className="button-row">
                {data.attachments
                  .filter(
                    (a) =>
                      a.sourceId === s.id &&
                      !data.documentPages?.some(
                        (p) => p.imageAttachmentId === a.id,
                      ),
                  )
                  .map((a) => (
                    <Button
                      key={a.id}
                      className="text-button"
                      onPress={() =>
                        download(
                          a.name,
                          new Blob(
                            [new Uint8Array(fromBase64(a.base64)).buffer],
                            { type: a.mimeType },
                          ),
                        )
                      }
                    >
                      Pobierz oryginał
                    </Button>
                  ))}
                <Button
                  className="text-button"
                  onPress={() => {
                    setUsageSource(s.id);
                    setUsageVerified(s.usageVerified);
                    setAIAllowed(s.aiAllowed);
                  }}
                >
                  Zasady użycia
                </Button>
                <Button
                  className="icon-button"
                  aria-label={`Usuń źródło ${s.name}`}
                  onPress={() => setSourceToDelete(s.id)}
                >
                  <Trash2 size={17} />
                </Button>
              </div>
            </div>
          ))}
        {data.sources.filter((s) => s.status !== "deleted").length === 0 && (
          <p>Nie masz jeszcze zaimportowanych źródeł.</p>
        )}
      </section>
      {existingReview.sourceConflicts.length > 0 && (
        <section className="panel">
          <h2>Nakładające się pomiary</h2>
          <ConflictReview
            conflicts={existingReview.sourceConflicts}
            choices={storedChoices}
            onChange={setStoredChoices}
          />
          <Button
            className="secondary"
            onPress={async () => {
              try {
                await update(resolveObservationConflicts(data, storedChoices));
                setStoredChoices({});
                notify(
                  "Wybór źródeł nadrzędnych zapisany. Zależne raporty wymagają ponownego wygenerowania.",
                );
              } catch (error) {
                notify(errorText(error));
              }
            }}
          >
            Zapisz wybór źródeł
          </Button>
        </section>
      )}
      {(data.importBatches?.length ?? 0) > 0 && (
        <section className="panel">
          <h2>Zatwierdzone paczki importu</h2>
          <p className="caption">
            Rejestr jest częścią szyfrowanego sejfu. Liczby opisują rekordy
            odczytane w paczce; źródła nadrzędne określają, które pomiary są
            używane.
          </p>
          {[...(data.importBatches ?? [])].reverse().map((batch) => (
            <details key={batch.id}>
              <summary>
                {data.sources.find((s) => s.id === batch.sourceId)?.name ??
                  "Źródło"}{" "}
                · {fmt(batch.confirmedAt)} ·{" "}
                {batch.supersededAt ? "zastąpiona" : "zatwierdzona"}
              </summary>
              <p>
                Parser: {batch.parserVersion}. Rewizja źródła:{" "}
                {batch.sourceRevision}. Użycie paczki: lokalne; zasady źródła i
                zgoda na wysłanie są sprawdzane osobno.
              </p>
              <p>
                {batch.range
                  ? `Zakres: ${fmt(batch.range.start)} do ${fmt(batch.range.end)}.`
                  : "Brak ustalonego zakresu czasu w tej paczce."}{" "}
                Grafik: {batch.counts.calendar}, anulowania:{" "}
                {batch.counts.cancellations}, obserwacje:{" "}
                {batch.counts.observations}, pola dokumentu:{" "}
                {batch.counts.facts}, strony: {batch.counts.pages}.
              </p>
              <p>
                Strefa dla czasu bez strefy:{" "}
                {batch.configuration.timezone ?? "niewymagana"}. Rodzaj grafiku:{" "}
                {batch.configuration.calendarKind === "rest"
                  ? "chroniony odpoczynek"
                  : batch.configuration.calendarKind
                    ? "praca / zajętość"
                    : "nie dotyczy"}
                .{" "}
                {batch.configuration.delimiter
                  ? `Separator: ${batch.configuration.delimiter === "\t" ? "tabulator" : batch.configuration.delimiter}.`
                  : ""}
              </p>
              {batch.configuration.csvMapping && (
                <ul>
                  {Object.entries(batch.configuration.csvMapping).map(
                    ([field, column]) => (
                      <li key={field}>
                        {field}: {column}
                      </li>
                    ),
                  )}
                </ul>
              )}
              <p className="caption">
                Identyfikator paczki: {batch.id}. SHA-256: {batch.hash}.{" "}
                {batch.supersededAt
                  ? `Zastąpiono: ${fmt(batch.supersededAt)}.`
                  : ""}
              </p>
            </details>
          ))}
        </section>
      )}
      <section className="panel">
        <h2>Obserwacje i ich źródła</h2>
        <p className="caption">
          Lista obejmuje wybrane pomiary. Niewybrane, nakładające się źródła nie
          są sumowane.
        </p>
        {data.observations.length === 0 && <p>Brak zapisanych obserwacji.</p>}
        {data.observations
          .slice(-100)
          .reverse()
          .map((o) => (
            <div className="fact-row" key={o.id}>
              <div>
                <strong>
                  {o.metric}: {o.value ?? "Brak pomiaru"} {o.unit}
                </strong>
                <small>
                  {fmt(o.start)} ·{" "}
                  {data.sources.find((s) => s.id === o.sourceId)?.name ??
                    "Źródło niedostępne"}{" "}
                  · wersja {o.revision}
                </small>
                {o.quality && <small>{o.quality}</small>}
              </div>
              <Button
                className="text-button"
                onPress={() => {
                  setEditObservation(o.id);
                  setObservationValue(String(o.value ?? ""));
                  setObservationUnit(o.unit);
                }}
              >
                Sprawdź / popraw pomiar
              </Button>
            </div>
          ))}
        {data.observations.length > 100 && (
          <p>
            Pokazano ostatnie 100 obserwacji. Eksport CSV zawiera wszystkie
            wybrane pomiary.
          </p>
        )}
      </section>
      <section className="panel">
        <h2>Fragmenty dokumentów</h2>
        <p className="caption">
          Tylko potwierdzone pola mogą trafić do raportu. Nieczytelne liczby
          pozostają do sprawdzenia.
        </p>
        {data.documentFacts.map((f) => (
          <div className="fact-row" key={f.id}>
            <div>
              <span className="tag">
                {f.status === "confirmed"
                  ? "Potwierdzone"
                  : f.status === "rejected"
                    ? "Odrzucone"
                    : "Do sprawdzenia"}
              </span>
              <p>
                {f.value}
                {f.unit && !f.value.includes(f.unit) ? ` ${f.unit}` : ""}
              </p>
              <small>
                {data.sources.find((s) => s.id === f.sourceId)?.name} · strona{" "}
                {f.page}
              </small>
            </div>
            <Button
              className="text-button"
              onPress={() => {
                setEditFact(f.id);
                setValue(f.value);
                setFactUnit(f.unit ?? "");
              }}
            >
              Sprawdź / popraw
            </Button>
          </div>
        ))}
      </section>
      <section className="panel">
        <h2>Zgody na usługi</h2>
        <p>
          Podstawowy plan, dokumenty i raport działają bez AI. Zewnętrzna
          wysyłka wymaga osobnej zgody i podglądu wybranej treści.
        </p>
        {data.consents.map((c) => (
          <div key={c.id} className="source-row">
            <div>
              {c.provider} ·{" "}
              {c.purpose === "audio" ? "nagranie" : "wybrane fakty"}
              <small>
                {c.revokedAt ? "Zgoda wycofana" : `Zgoda z ${fmt(c.grantedAt)}`}
              </small>
            </div>
            {!c.revokedAt && (
              <Button
                className="secondary"
                onPress={async () => {
                  try {
                    await update({
                      ...data,
                      consents: data.consents.map((x) =>
                        x.id === c.id ? { ...x, revokedAt: now() } : x,
                      ),
                    });
                    notify(
                      "Zgoda została wycofana. Nie usuwa to treści już przesłanej do dostawcy.",
                    );
                  } catch {
                    /* update reports the error */
                  }
                }}
              >
                Wycofaj zgodę
              </Button>
            )}
          </div>
        ))}
      </section>
      <div className="button-row">
        <Button
          className="secondary"
          onPress={() => {
            cancelAllImports();
            void lock();
          }}
        >
          Zablokuj sejf
        </Button>
        {data.profile.mode === "demo" && (
          <Button className="secondary" onPress={() => void resetDemo()}>
            Resetuj tylko dane demo
          </Button>
        )}
        <Button className="danger" onPress={() => setConfirmDelete(true)}>
          Usuń wszystkie dane tego profilu
        </Button>
      </div>
      {preview && (
        <DialogBox title="Sprawdź import przed zapisem" onClose={closePreview}>
          <p>
            {preview.source.name} · {preview.calendar.length} przedziałów ·{" "}
            {preview.observations.length} obserwacji · {preview.facts.length}{" "}
            fragmentów
          </p>
          {preview.horizon && (
            <p>
              Grafik: {fmt(preview.horizon.start)} do {fmt(preview.horizon.end)}
              . Poza tym zakresem serie nie zostały sprawdzone.
            </p>
          )}
          {preview.issues.map((issue, index) => (
            <p
              key={index}
              className={
                issue.severity === "error" ? "error-text" : "warning-text"
              }
            >
              {issue.message}
            </p>
          ))}
          {previewReview?.error && (
            <p role="alert" className="error-text">
              {previewReview.error}
            </p>
          )}
          {replacement && (
            <div className="warning-text">
              <p>
                {replacement.legacy
                  ? "Starszy zapis nie zawiera identyfikatorów paczki. Nie można bezpiecznie ustalić jej zakresu. Dalsze zatwierdzenie wymaga pełnego resetu tego źródła. Anuluj import, jeżeli chcesz zachować jego obecne dane."
                  : "Zmieniono konfigurację wcześniej zatwierdzonej paczki. Jej poprzednie rekordy zostaną zastąpione wynikiem widocznym poniżej. Pozostałe paczki tego źródła zachowają swoje dane."}
              </p>
              <p>
                Do zastąpienia: {replacement.calendar} przedziałów grafiku,{" "}
                {replacement.observations} obserwacji (w tym{" "}
                {replacement.corrections} z własną korektą), {replacement.facts}{" "}
                pól dokumentu. Własne korekty zastępowanych rekordów trzeba
                wprowadzić ponownie. Zależny przyszły plan wymaga ponownej
                walidacji, a raport ponownego wygenerowania.
              </p>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={replaceReviewedBatch}
                  onChange={(e) => setReplaceReviewedBatch(e.target.checked)}
                />
                {replacement.legacy
                  ? "Potwierdzam pełny reset danych tego źródła i zastąpienie ich podglądem"
                  : "Sprawdziłem podgląd i potwierdzam zastąpienie rekordów tej paczki oraz ich korekt"}
              </label>
            </div>
          )}
          <ConflictReview
            conflicts={previewReview?.sourceConflicts ?? []}
            choices={choices}
            onChange={setChoices}
          />
          {preview.calendar.slice(0, 50).map((c) => (
            <p key={c.id}>
              {c.label} · {fmt(c.start)} → {fmt(c.end)} · {c.timezone}
              {c.allDay ? " · cały dzień, koniec wyłączny" : ""}
            </p>
          ))}
          {preview.calendar.length > 50 && (
            <p>
              Pokazano pierwsze 50 przedziałów z {preview.calendar.length}. Cały
              zakres zostanie zapisany.
            </p>
          )}
          {preview.cancellations.map((c, i) => (
            <p key={i}>
              Anulowanie zdarzenia {c.uid}
              {c.recurrenceId ? ` (${c.recurrenceId})` : ""}, wersja {c.version}
              .
            </p>
          ))}
          {preview.observations.slice(0, 50).map((o) => (
            <p key={o.id}>
              {o.metric}: {o.value} {o.unit} · {fmt(o.start)} · {o.sourceName}
              {o.originalUnit !== o.unit
                ? ` · oryginał: ${o.originalValue} ${o.originalUnit}`
                : ""}
            </p>
          ))}
          {preview.observations.length > 50 && (
            <p>
              Pokazano pierwsze 50 obserwacji z {preview.observations.length}.
            </p>
          )}
          {preview.pages.map((page) => (
            <section key={page.page} className="document-review">
              <h3>
                Strona {page.page} ·{" "}
                {page.extraction === "ocr" ? "Odczyt OCR" : "Tekst PDF"}
              </h3>
              <div className="data-grid">
                <div>
                  {page.image && (
                    <img
                      className="document-image"
                      src={`data:${page.imageType ?? "image/png"};base64,${toBase64(page.image)}`}
                      alt={`Oryginalna strona ${page.page} dokumentu ${preview.source.name}`}
                    />
                  )}
                  <details>
                    <summary>Odczytany tekst strony {page.page}</summary>
                    <pre className="source-text">{page.text}</pre>
                  </details>
                </div>
                <div>
                  {preview.facts
                    .filter((f) => f.page === page.page)
                    .map((f) => (
                      <div className="fact-review" key={f.id}>
                        <Field label={`${f.label}, strona ${f.page}`}>
                          <textarea
                            value={f.text}
                            onChange={(e) =>
                              setPreview({
                                ...preview,
                                facts: preview.facts.map((x) =>
                                  x.id === f.id
                                    ? reviewFact(
                                        x,
                                        { text: e.target.value },
                                        "pending",
                                      )
                                    : x,
                                ),
                              })
                            }
                          />
                          <small>Oryginalny odczyt: {f.originalText}</small>
                        </Field>
                        <Field
                          label={`Jednostka pola ${f.label}`}
                          hint="Zostaw puste, jeśli jednostki nie ma w źródle."
                        >
                          <input
                            value={f.unit ?? ""}
                            onChange={(e) =>
                              setPreview({
                                ...preview,
                                facts: preview.facts.map((x) =>
                                  x.id === f.id
                                    ? reviewFact(
                                        x,
                                        { unit: e.target.value || undefined },
                                        "pending",
                                      )
                                    : x,
                                ),
                              })
                            }
                          />
                        </Field>
                        <Field label={`Status pola ${f.label}`}>
                          <select
                            value={f.status}
                            onChange={(e) =>
                              setPreview({
                                ...preview,
                                facts: preview.facts.map((x) =>
                                  x.id === f.id
                                    ? {
                                        ...x,
                                        status: e.target
                                          .value as typeof f.status,
                                      }
                                    : x,
                                ),
                              })
                            }
                          >
                            <option value="pending">Do sprawdzenia</option>
                            <option value="confirmed">Potwierdzam</option>
                            <option value="rejected">Odrzucam</option>
                          </select>
                        </Field>
                        {f.referenceRange && (
                          <small>
                            Zakres zapisany w źródle: {f.referenceRange}
                          </small>
                        )}
                        {f.date && (
                          <small>Data zapisana w źródle: {f.date}</small>
                        )}
                      </div>
                    ))}
                  <Button
                    className="text-button"
                    onPress={() =>
                      setPreview({
                        ...preview,
                        facts: [
                          ...preview.facts,
                          {
                            id: uid(),
                            sourceId: preview.source.id,
                            page: page.page,
                            label: "Przepisany fragment",
                            text: "",
                            originalText: "",
                            status: "pending",
                            extraction: page.extraction,
                            version: 1,
                          },
                        ],
                      })
                    }
                  >
                    Przepisz dodatkowy fragment ze strony {page.page}
                  </Button>
                </div>
              </div>
            </section>
          ))}
          <div className="button-row">
            <Button
              className="primary"
              isDisabled={
                !preview.complete ||
                Boolean(previewReview?.error) ||
                Boolean(replacement && !replaceReviewedBatch) ||
                preview.facts.some(
                  (f) => f.status === "confirmed" && !f.text.trim(),
                )
              }
              onPress={async () => {
                try {
                  const imported = persistImport(data, preview, {
                    confirmedFactIds: preview.facts
                      .filter((f) => f.status === "confirmed")
                      .map((f) => f.id),
                    rejectedFactIds: preview.facts
                      .filter((f) => f.status === "rejected")
                      .map((f) => f.id),
                    sourceResolutions: choices,
                    replaceReviewedBatch,
                  });
                  if (imported !== data) await update(imported);
                  setPreview(null);
                  notify(
                    imported === data
                      ? "Ta paczka z tą konfiguracją jest już zapisana. Dane i własne korekty pozostają bez zmian."
                      : "Import zapisany. Niepotwierdzone fragmenty pozostają do sprawdzenia.",
                  );
                } catch (error) {
                  notify(errorText(error));
                }
              }}
            >
              <Check size={17} /> Zatwierdź import
            </Button>
            <Button className="secondary" onPress={closePreview}>
              Anuluj import
            </Button>
          </div>
        </DialogBox>
      )}
      {editFact && selectedFact && (
        <DialogBox
          title="Sprawdź fragment źródła"
          onClose={() => setEditFact(null)}
        >
          <p>
            {data.sources.find((s) => s.id === selectedFact.sourceId)?.name} ·
            strona {selectedFact.page}
          </p>
          <div className="data-grid">
            <div>
              {selectedImage ? (
                <img
                  className="document-image"
                  src={`data:${selectedImage.mimeType};base64,${selectedImage.base64}`}
                  alt={`Oryginalna strona ${selectedFact.page}`}
                />
              ) : (
                <p>
                  Podgląd strony nie jest zapisany. Pobierz oryginał z listy
                  źródeł.
                </p>
              )}
              {selectedPage && (
                <details>
                  <summary>Odczytany tekst strony</summary>
                  <pre className="source-text">{selectedPage.text}</pre>
                </details>
              )}
            </div>
            <div>
              <Field label="Treść fragmentu">
                <textarea
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                />
              </Field>
              <Field label="Jednostka fragmentu (opcjonalnie)">
                <input
                  value={factUnit}
                  onChange={(e) => setFactUnit(e.target.value)}
                />
              </Field>
              <p>
                Oryginalny odczyt:{" "}
                {selectedMetadata?.originalText ??
                  selectedFact.correctedFrom ??
                  selectedFact.value}
              </p>
              {selectedMetadata?.referenceRange && (
                <p>Zakres ze źródła: {selectedMetadata.referenceRange}</p>
              )}
            </div>
          </div>
          <div className="button-row">
            {(["confirmed", "pending", "rejected"] as const).map(
              (status, i) => (
                <Button
                  key={status}
                  className={i === 0 ? "primary" : "secondary"}
                  isDisabled={status === "confirmed" && !value.trim()}
                  onPress={async () => {
                    try {
                      const changed = correctSource(
                        data,
                        selectedFact.sourceId,
                        now(),
                      );
                      await update({
                        ...changed,
                        documentFacts: changed.documentFacts.map((f) =>
                          f.id === editFact
                            ? {
                                ...f,
                                value,
                                unit: factUnit || undefined,
                                status,
                                revision: f.revision + 1,
                                correctedFrom: f.correctedFrom ?? f.value,
                              }
                            : f,
                        ),
                      });
                      setEditFact(null);
                      notify(
                        "Pole zapisane. Zależne przyszłe plany wymagają ponownego sprawdzenia.",
                      );
                    } catch (error) {
                      notify(errorText(error));
                    }
                  }}
                >
                  {["Potwierdź", "Zostaw do sprawdzenia", "Odrzuć"][i]}
                </Button>
              ),
            )}
          </div>
        </DialogBox>
      )}
      {editObservation && (
        <DialogBox
          title="Sprawdź pomiar"
          onClose={() => setEditObservation(null)}
        >
          {(() => {
            const observation = data.observations.find(
              (o) => o.id === editObservation,
            )!;
            const original = data.observationImportState?.records.find(
              (r) => r.id === editObservation,
            );
            return (
              <>
                <p>
                  {observation.metric} · {fmt(observation.start)} ·{" "}
                  {
                    data.sources.find((s) => s.id === observation.sourceId)
                      ?.name
                  }
                </p>
                {original && (
                  <p>
                    Wartość źródłowa: {original.originalValue}{" "}
                    {original.originalUnit}. Czas źródłowy:{" "}
                    {original.originalLocal} ({original.timezone}).
                  </p>
                )}
                <Field label="Poprawiona wartość pomiaru">
                  <input
                    inputMode="decimal"
                    value={observationValue}
                    onChange={(e) => setObservationValue(e.target.value)}
                  />
                </Field>
                <Field
                  label="Poprawiona jednostka pomiaru"
                  hint="Pusta wartość nie zostanie zamieniona na zero. Czas zostanie przeliczony na minuty."
                >
                  <input
                    value={observationUnit}
                    onChange={(e) => setObservationUnit(e.target.value)}
                  />
                </Field>
                <div className="button-row">
                  <Button
                    className="primary"
                    onPress={async () => {
                      try {
                        const normalized = normalizeUnit(
                          observation.metric,
                          parsePolishNumber(observationValue),
                          observationUnit,
                        );
                        const changed = correctSource(
                          data,
                          observation.sourceId,
                          now(),
                        );
                        await update({
                          ...changed,
                          observations: changed.observations.map((o) =>
                            o.id === editObservation
                              ? {
                                  ...o,
                                  ...normalized,
                                  revision: o.revision + 1,
                                  quality: `Korekta własna; poprzednio ${o.value} ${o.unit}`,
                                }
                              : o,
                          ),
                          observationImportState: changed.observationImportState
                            ? {
                                ...changed.observationImportState,
                                records:
                                  changed.observationImportState.records.map(
                                    (r) =>
                                      r.id === editObservation
                                        ? {
                                            ...r,
                                            ...normalized,
                                            sourceVersion:
                                              r.sourceVersion ?? r.version,
                                            version: r.version + 1,
                                          }
                                        : r,
                                  ),
                              }
                            : undefined,
                        });
                        setEditObservation(null);
                        notify(
                          "Korekta pomiaru zapisana. Zależne raporty są nieaktualne.",
                        );
                      } catch (error) {
                        notify(errorText(error));
                      }
                    }}
                  >
                    Zapisz korektę pomiaru
                  </Button>
                  <Button
                    className="danger"
                    onPress={async () => {
                      try {
                        const changed = correctSource(
                          data,
                          observation.sourceId,
                          now(),
                        );
                        await update({
                          ...changed,
                          observations: changed.observations.filter(
                            (o) => o.id !== editObservation,
                          ),
                          observationImportState: changed.observationImportState
                            ? {
                                records:
                                  changed.observationImportState.records.filter(
                                    (r) => r.id !== editObservation,
                                  ),
                                resolutions:
                                  changed.observationImportState.resolutions.filter(
                                    (r) =>
                                      !r.recordIds.includes(editObservation),
                                  ),
                              }
                            : undefined,
                        });
                        setEditObservation(null);
                        notify("Pomiar usunięty.");
                      } catch (error) {
                        notify(errorText(error));
                      }
                    }}
                  >
                    Usuń pomiar
                  </Button>
                </div>
              </>
            );
          })()}
        </DialogBox>
      )}
      {usageSource && (
        <DialogBox
          title="Sprawdź zasady użycia źródła"
          onClose={() => setUsageSource(null)}
        >
          <p>
            Techniczny odczyt pliku nie potwierdza prawa do przekazania jego
            treści dostawcy AI. Sprawdź pochodzenie dokumentu i warunki jego
            użycia. To ustawienie nie wysyła danych.
          </p>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={usageVerified}
              onChange={(e) => {
                setUsageVerified(e.target.checked);
                if (!e.target.checked) setAIAllowed(false);
              }}
            />{" "}
            Sprawdziłem zasady użycia tego źródła
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={aiAllowed}
              disabled={!usageVerified}
              onChange={(e) => setAIAllowed(e.target.checked)}
            />{" "}
            Zasady pozwalają przekazać wybrane fragmenty do pomocy językowej AI
          </label>
          <p>
            Każda transmisja nadal wymaga osobnego podglądu, zgody na cel i
            dostawcę oraz włączonej usługi.
          </p>
          <Button
            className="primary"
            onPress={async () => {
              try {
                await update({
                  ...data,
                  sources: data.sources.map((s) =>
                    s.id === usageSource
                      ? {
                          ...s,
                          usageVerified,
                          aiAllowed: usageVerified && aiAllowed,
                        }
                      : s,
                  ),
                });
                setUsageSource(null);
                notify(
                  "Zasady użycia zapisane. Żadne dane nie zostały wysłane.",
                );
              } catch (error) {
                notify(errorText(error));
              }
            }}
          >
            Zapisz zasady użycia
          </Button>
        </DialogBox>
      )}
      {sourceToDelete && (
        <DialogBox
          title="Usunąć źródło i jego pochodne?"
          onClose={() => setSourceToDelete(null)}
        >
          <p>
            Treść zniknie z obserwacji, dokumentów i zależnych raportów. Pobrane
            wcześniej pliki pozostają pod Twoją kontrolą.
          </p>
          <Button
            className="danger"
            onPress={async () => {
              try {
                await update(removeImportedSource(data, sourceToDelete));
                setSourceToDelete(null);
                notify("Źródło i jego treści zostały usunięte.");
              } catch (error) {
                notify(errorText(error));
              }
            }}
          >
            Usuń źródło
          </Button>
        </DialogBox>
      )}
      {confirmDelete && (
        <DialogBox
          title="Usunąć lokalny profil?"
          onClose={() => setConfirmDelete(false)}
        >
          <p>
            Usunięte zostaną dane, załączniki i lokalne raporty tego profilu.
            Pobrane kopie i raporty musisz usunąć osobno.
          </p>
          <Button
            className="danger"
            onPress={async () => {
              cancelAllImports();
              await vault.remove();
              await lock();
            }}
          >
            Potwierdzam usunięcie profilu
          </Button>
        </DialogBox>
      )}
    </>
  );
}
