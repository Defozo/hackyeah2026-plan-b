import { useState } from "react";
import { DateTime } from "luxon";
import { Check } from "lucide-react";
import type { Constraint } from "@planb/domain";
import type { ViewProps } from "./App";
import { Button, DialogBox, Field } from "./components";
import { errorText, fromLocal, localInput, now, uid } from "./utils";
export default function AgreementForm({
  data,
  update,
  notify,
  onClose,
  editingId,
}: { onClose: () => void; editingId?: string } & ViewProps) {
  const previous = data.constraints.find((c) => c.id === editingId);
  const [text, setText] = useState(previous?.sourceText ?? ""),
    [kind, setKind] = useState<Constraint["kind"] | "variant">(
      previous?.kind ?? "unmapped",
    ),
    [activity, setActivity] = useState(previous?.activityTypes?.[0] ?? ""),
    [minutes, setMinutes] = useState(previous?.maxDurationMinutes ?? 20),
    [date, setDate] = useState(
      previous?.consultationDate ?? DateTime.now().toISODate()!,
    ),
    [source, setSource] = useState(
      data.sources.find((s) => s.id === previous?.sourceId)?.name ??
        "Ustalenie po konsultacji",
    ),
    [until, setUntil] = useState(
      previous?.validUntil
        ? DateTime.fromISO(previous.validUntil).toISODate()!
        : "",
    ),
    [confirmed, setConfirmed] = useState(false),
    [resourceId, setResourceId] = useState(previous?.resourceIds?.[0] ?? ""),
    [windowStart, setWindowStart] = useState(
      previous?.windows?.[0]
        ? localInput(previous.windows[0].start, data.profile.timezone)
        : "",
    ),
    [windowEnd, setWindowEnd] = useState(
      previous?.windows?.[0]
        ? localInput(previous.windows[0].end, data.profile.timezone)
        : "",
    ),
    [variantId, setVariantId] = useState(""),
    [saving, setSaving] = useState(false);
  async function save() {
    setSaving(true);
    try {
      const sourceId = previous?.sourceId ?? uid(),
        stamp = now();
      const priorSource = data.sources.find((s) => s.id === sourceId);
      const sources = [
        ...data.sources.filter((s) => s.id !== sourceId),
        {
          id: sourceId,
          kind: "manual" as const,
          name: source,
          createdAt: priorSource?.createdAt ?? stamp,
          status: "active" as const,
          revision: (priorSource?.revision ?? 0) + 1,
          aiAllowed: priorSource?.aiAllowed ?? false,
          usageVerified: true,
          synthetic: data.profile.mode === "demo",
        },
      ];
      if (kind === "variant") {
        if (!confirmed)
          throw Error("Potwierdź zgodność wariantu z ustaleniem.");
        const original = data.activities
          .flatMap((a) => a.variants)
          .find((v) => v.id === variantId);
        if (!original) throw Error("Wybierz własny wariant.");
        await update({
          ...data,
          revision: data.revision + 1,
          sources,
          constraints: data.constraints.filter((c) => c.id !== previous?.id),
          documentFacts: [
            ...data.documentFacts,
            {
              id: uid(),
              sourceId,
              page: 1,
              label: `Uzgodniony wariant, ${date}`,
              value: text,
              status: "confirmed",
              revision: 1,
            },
          ],
          activities: data.activities.map((a) => ({
            ...a,
            variants: a.variants.map((v) =>
              v.id === variantId ? { ...v, sourceId, confirmed: true } : v,
            ),
          })),
          plans: data.plans.map((p) =>
            Date.parse(p.start) > Date.now()
              ? { ...p, needsRevalidation: true }
              : p,
          ),
          carePackets: data.carePackets.map((p) =>
            p.sourceIds.includes(sourceId) ? { ...p, stale: true } : p,
          ),
          exports: data.exports.map((e) =>
            e.sourceIds.includes(sourceId) ? { ...e, status: "stale" } : e,
          ),
        });
        notify("Własny wariant zachował źródło i datę konsultacji.");
        onClose();
        return;
      }
      const windows =
        kind === "available"
          ? [
              {
                id: uid(),
                start: fromLocal(windowStart, data.profile.timezone),
                end: fromLocal(windowEnd, data.profile.timezone),
                sourceId,
                timezone: data.profile.timezone,
              },
            ]
          : undefined;
      if (windows && windows[0].end <= windows[0].start)
        throw Error("Koniec przedziału musi być późniejszy od początku.");
      if (kind === "requires_resource" && !resourceId)
        throw Error("Wybierz wymagany zasób.");
      const constraint: Constraint = {
        id: previous?.id ?? uid(),
        kind,
        sourceId,
        sourceText: text,
        consultationDate: date,
        mappingState:
          kind === "unmapped" || !confirmed ? "needs_review" : "confirmed",
        activityTypes: activity ? [activity] : undefined,
        maxDurationMinutes: kind === "max_duration" ? minutes : undefined,
        resourceIds: kind === "requires_resource" ? [resourceId] : undefined,
        windows,
        validFrom: DateTime.fromISO(date, { zone: data.profile.timezone })
          .startOf("day")
          .toUTC()
          .toISO()!,
        validUntil: until
          ? DateTime.fromISO(until, { zone: data.profile.timezone })
              .endOf("day")
              .toUTC()
              .toISO()!
          : undefined,
      };
      await update({
        ...data,
        revision: data.revision + 1,
        sources,
        constraints: [
          ...data.constraints.filter((c) => c.id !== previous?.id),
          constraint,
        ],
        plans: data.plans.map((p) =>
          Date.parse(p.start) > Date.now()
            ? { ...p, needsRevalidation: true }
            : p,
        ),
        carePackets: data.carePackets.map((p) =>
          p.sourceIds.includes(sourceId) ? { ...p, stale: true } : p,
        ),
        exports: data.exports.map((e) =>
          e.sourceIds.includes(sourceId) ? { ...e, status: "stale" } : e,
        ),
      });
      notify(
        constraint.mappingState === "confirmed"
          ? "Ustalenie zapisane. Kolejna naprawa respektuje ograniczenie."
          : "Ustalenie wymaga wyjaśnienia. Objęte nim aktywności nie będą automatycznie dobierane.",
      );
      onClose();
    } catch (e) {
      notify(errorText(e));
    } finally {
      setSaving(false);
    }
  }
  return (
    <DialogBox
      title={previous ? "Przegląd ustalenia" : "Ustalenie po konsultacji"}
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="Treść ustalenia">
          <textarea
            required
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </Field>
        <div className="form-grid">
          <Field label="Źródło">
            <input
              required
              value={source}
              onChange={(e) => setSource(e.target.value)}
            />
          </Field>
          <Field label="Data konsultacji">
            <input
              required
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </Field>
        </div>
        <Field label="Jakie ograniczenie zostało ustalone?">
          <select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as typeof kind);
              setConfirmed(false);
            }}
          >
            <option value="unmapped">
              Niejasne / nieobsługiwane, wymaga wyjaśnienia
            </option>
            <option value="exclude">Wykluczenie aktywności</option>
            <option value="max_duration">Maksymalny czas aktywności</option>
            <option value="requires_resource">Wymagany zasób</option>
            <option value="available">Dozwolony przedział czasu</option>
            <option value="variant">Uzgodniony własny wariant</option>
          </select>
        </Field>
        {kind === "variant" ? (
          <Field label="Własny wariant uzgodniony ze specjalistą">
            <select
              required
              value={variantId}
              onChange={(e) => setVariantId(e.target.value)}
            >
              <option value="">Wybierz znany wariant</option>
              {data.activities
                .flatMap((a) => a.variants)
                .map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
            </select>
          </Field>
        ) : (
          <Field label="Czynność, której dotyczy">
            <select
              value={activity}
              onChange={(e) => setActivity(e.target.value)}
            >
              <option value="">Wszystkie / zakres nieznany</option>
              {[
                ...new Set(
                  data.activities.flatMap((a) =>
                    a.variants.map((v) => v.activityType),
                  ),
                ),
              ].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </Field>
        )}
        {kind === "max_duration" && (
          <Field label="Maksymalny czas (min)">
            <input
              required
              type="number"
              min={1}
              max={1440}
              value={minutes}
              onChange={(e) => setMinutes(Number(e.target.value))}
            />
          </Field>
        )}
        {kind === "requires_resource" && (
          <Field label="Wymagany zasób">
            <select
              value={resourceId}
              onChange={(e) => setResourceId(e.target.value)}
              required
            >
              <option value="">Wybierz</option>
              {data.resources.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </Field>
        )}
        {kind === "available" && (
          <div className="form-grid">
            <Field label="Dozwolony początek">
              <input
                type="datetime-local"
                required
                value={windowStart}
                onChange={(e) => setWindowStart(e.target.value)}
              />
            </Field>
            <Field label="Dozwolony koniec">
              <input
                type="datetime-local"
                required
                value={windowEnd}
                onChange={(e) => setWindowEnd(e.target.value)}
              />
            </Field>
          </div>
        )}
        {kind !== "variant" && (
          <Field label="Obowiązuje do (opcjonalnie)">
            <input
              type="date"
              min={date}
              value={until}
              onChange={(e) => setUntil(e.target.value)}
            />
          </Field>
        )}
        <div className="compare">
          <div>
            <span className="eyebrow">TWOJE USTALENIE</span>
            <p>{text || "Wpisz treść źródłową"}</p>
          </div>
          <div>
            <span className="eyebrow">WPŁYW NA KOLEJNY PLAN</span>
            <p>
              {kind === "unmapped"
                ? "Automatyczny dobór objętych czynności będzie wstrzymany do wyjaśnienia."
                : kind === "exclude"
                  ? "Objęta czynność zostanie wykluczona."
                  : kind === "max_duration"
                    ? `Czas objętej aktywności nie przekroczy ${minutes} min.`
                    : kind === "requires_resource"
                      ? "Dostępność wskazanego zasobu stanie się obowiązkowym warunkiem."
                      : kind === "available"
                        ? "Cały wariant musi mieścić się w podanym przedziale."
                        : "Wariant zachowa datę i źródło ustalenia."}
            </p>
          </div>
        </div>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />{" "}
          Potwierdzam, że wybrane ograniczenie wiernie odwzorowuje ustalenie.
        </label>
        <p className="caption">
          Ogólna notatka nie staje się zgodą na aktywność. Wygaśnięcie
          ograniczenia wymaga ponownego przeglądu.
        </p>
        <Button type="submit" className="primary" isDisabled={saving}>
          <Check size={17} /> Zapisz ustalenie
        </Button>
      </form>
    </DialogBox>
  );
}
