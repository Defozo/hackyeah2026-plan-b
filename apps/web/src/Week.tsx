import { useState } from "react";
import { useForm } from "react-hook-form";
import { DateTime } from "luxon";
import {
  ArrowDown,
  ArrowUp,
  CalendarDays,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import type { ViewProps } from "./App";
import {
  createRepairInput,
  repairPlan,
  type ActivityVariant,
  type Priority,
  type Resource,
} from "@planb/domain";
import { Button, DialogBox, Field } from "./components";
import { Timeline } from "./Timeline";
import { errorText, fromLocal, localInput, now, uid } from "./utils";

const priorityLabels: Record<Priority, string> = {
  activity: "Rodzaj aktywności",
  duration: "Długość",
  time: "Pora",
  location: "Miejsce",
  companionship: "Towarzystwo",
};
const formatMinutes = (value: number) =>
  `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
function parseTimes(value: string) {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s))
        throw Error("Preferowaną porę wpisz jako HH:MM, np. 17:30.");
      const [h, m] = s.split(":").map(Number);
      return h! * 60 + m!;
    });
}

export function ActivityForm({
  data,
  update,
  notify,
  onClose,
  editVariant,
}: { onClose: () => void; editVariant?: ActivityVariant } & ViewProps) {
  const first = DateTime.now()
    .setZone(data.profile.timezone)
    .plus({ hours: 1 })
    .startOf("hour");
  const { register, handleSubmit, watch } = useForm({
    defaultValues: {
      name: editVariant?.name ?? "",
      duration: editVariant?.durationMinutes ?? 30,
      preparation: editVariant?.preparationMinutes ?? 0,
      travel: editVariant
        ? editVariant.travelMinutes === null
          ? ""
          : String(editVariant.travelMinutes)
        : "0",
      location: editVariant?.locationId ?? "Przy domu",
      intent: editVariant?.intentIds[0] ?? data.intents[0]?.id ?? "",
      customIntent: "",
      start: first.toFormat("yyyy-MM-dd'T'HH:mm"),
      window: 90,
      templateId: editVariant?.templateId ?? "",
      equipment: editVariant?.resourceIds.join(", ") ?? "",
      companionship: editVariant?.companionship ?? "",
      preferred:
        editVariant?.preferredStartMinutes?.map(formatMinutes).join(", ") ?? "",
      travelOptions: editVariant?.travelOptionsMinutes?.join(", ") ?? "",
      schedule: !editVariant,
    },
  });
  const [busy, setBusy] = useState(false),
    [extraIntents, setExtraIntents] = useState(
      editVariant?.intentIds.slice(1) ?? [],
    );
  return (
    <DialogBox
      title={editVariant ? "Edytuj znany wariant" : "Twoja znana aktywność"}
      onClose={onClose}
    >
      <p>
        Opisz czynność, którą już znasz. Aplikacja nie określa, czy możesz
        wykonywać ją ze względów zdrowotnych.
      </p>
      <form
        onSubmit={handleSubmit(async (f) => {
          setBusy(true);
          try {
            const savedAt = now(),
              id = editVariant?.id ?? uid(),
              tid = editVariant?.templateId || f.templateId || uid(),
              location = f.location.trim();
            if (!f.name.trim() || !location)
              throw Error("Podaj nazwę aktywności i miejsce.");
            const newIntent = f.customIntent.trim()
              ? { id: uid(), label: f.customIntent.trim() }
              : undefined;
            const intentId = newIntent?.id ?? f.intent;
            if (!intentId) throw Error("Wybierz cel albo wpisz własny.");
            const intentIds = [...new Set([intentId, ...extraIntents])];
            const travel = f.travel === "" ? null : Number(f.travel),
              duration = Number(f.duration),
              preparation = Number(f.preparation);
            if (
              ![
                duration,
                preparation,
                ...(travel === null ? [] : [travel]),
              ].every((n) => Number.isFinite(n) && n >= 0 && n <= 1440) ||
              duration <= 0
            )
              throw Error("Sprawdź czasy aktywności, przygotowania i dojazdu.");
            const travelOptions = f.travelOptions
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
              .map(Number);
            if (
              travelOptions.some(
                (n) => !Number.isFinite(n) || n < 0 || n > 1440,
              ) ||
              travelOptions.length > 12
            )
              throw Error(
                "Podaj najwyżej 12 możliwych czasów dojazdu od 0 do 1440 minut.",
              );
            const equipment = [
              ...new Set(
                f.equipment
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              ),
            ];
            const sourceId = editVariant?.sourceId ?? uid();
            const variant: ActivityVariant = {
              ...editVariant,
              id,
              templateId: tid,
              name: f.name.trim(),
              activityType:
                editVariant?.activityType ??
                data.activities.find((a) => a.id === tid)?.variants[0]
                  ?.activityType ??
                f.name.trim().toLowerCase(),
              intentIds,
              durationMinutes: duration,
              preparationMinutes: preparation,
              travelMinutes: travel,
              travelOptionsMinutes: travelOptions,
              locationId: location,
              resourceIds: equipment,
              companionship: f.companionship.trim() || undefined,
              preferredStartMinutes: parseTimes(f.preferred),
              confirmed: true,
              sourceId,
            };
            const activity = data.activities.find((a) => a.id === tid),
              revision = data.revision + 1;
            let next = {
              ...data,
              revision,
              intents: newIntent ? [...data.intents, newIntent] : data.intents,
              activities: activity
                ? data.activities.map((a) =>
                    a.id === tid
                      ? {
                          ...a,
                          variants: editVariant
                            ? a.variants.map((v) => (v.id === id ? variant : v))
                            : [...a.variants, variant],
                        }
                      : a,
                  )
                : [
                    ...data.activities,
                    { id: tid, name: f.name.trim(), variants: [variant] },
                  ],
              sources: data.sources.some((s) => s.id === sourceId)
                ? data.sources.map((s) =>
                    s.id === sourceId && editVariant
                      ? {
                          ...s,
                          status: "corrected" as const,
                          revision: s.revision + 1,
                        }
                      : s,
                  )
                : [
                    ...data.sources,
                    {
                      id: sourceId,
                      kind: "manual" as const,
                      name: `Własna aktywność: ${f.name.trim()}`,
                      createdAt: savedAt,
                      status: "active" as const,
                      revision: 1,
                      aiAllowed: false,
                      usageVerified: true,
                      synthetic: data.profile.mode === "demo",
                    },
                  ],
              resources: [
                ...data.resources,
                ...[location, ...equipment]
                  .filter((r) => !data.resources.some((x) => x.id === r))
                  .map((r) => ({
                    id: r,
                    label: r,
                    status: "available" as const,
                  })),
              ],
              plans: data.plans.map((p) =>
                editVariant &&
                p.variantId === id &&
                Date.parse(p.start) > Date.parse(savedAt)
                  ? {
                      ...p,
                      revision,
                      status: "conflict" as const,
                      needsRevalidation: true,
                    }
                  : p,
              ),
              carePackets: data.carePackets.map((p) =>
                editVariant && p.sourceIds.includes(sourceId)
                  ? { ...p, stale: true, approved: false }
                  : p,
              ),
              exports: data.exports.map((e) =>
                editVariant && e.sourceIds.includes(sourceId)
                  ? { ...e, status: "stale" as const }
                  : e,
              ),
            };
            if (f.schedule) {
              const start = fromLocal(f.start, data.profile.timezone),
                total = duration + preparation + (travel ?? 0),
                planId = uid();
              if (Date.parse(start) < Date.now())
                throw Error("Wybierz przyszły początek aktywności.");
              const originalLocalStart = f.start,
                end = new Date(Date.parse(start) + total * 60000).toISOString();
              next = {
                ...next,
                availability: [
                  ...next.availability,
                  {
                    id: uid(),
                    start,
                    end: new Date(
                      Date.parse(start) + Number(f.window) * 60000,
                    ).toISOString(),
                    timezone: data.profile.timezone,
                    originalLocalStart,
                    originalLocalEnd: localInput(
                      new Date(
                        Date.parse(start) + Number(f.window) * 60000,
                      ).toISOString(),
                      data.profile.timezone,
                    ),
                    kind: "available",
                  },
                ],
                plans: [
                  ...next.plans,
                  {
                    id: planId,
                    label: variant.name,
                    start,
                    end,
                    originalLocalStart,
                    originalLocalEnd: localInput(end, data.profile.timezone),
                    timezone: data.profile.timezone,
                    variantId: id,
                    intentId,
                    status: "accepted",
                    revision,
                    sourceId,
                  },
                ],
              };
              const result = repairPlan(
                createRepairInput(next, planId, savedAt),
              );
              if (result.conflicts.length)
                next = {
                  ...next,
                  plans: next.plans.map((p) =>
                    p.id === planId
                      ? {
                          ...p,
                          status: "conflict",
                          needsRevalidation: true,
                          conflictReasons: result.conflicts,
                        }
                      : p,
                  ),
                };
            }
            await update(next);
            notify(
              editVariant
                ? "Wariant zapisany. Powiązane przyszłe zamiary wymagają ponownego sprawdzenia."
                : "Własna aktywność została zapisana. Zamiar z konfliktem możesz teraz naprawić.",
            );
            onClose();
          } catch (e) {
            notify(errorText(e));
          } finally {
            setBusy(false);
          }
        })}
      >
        <Field label="Nazwa aktywności">
          <input
            required
            maxLength={100}
            placeholder="Np. spacer przy domu"
            {...register("name")}
          />
        </Field>
        <Field label="Cel">
          <select {...register("intent")}>
            {data.intents.map((i) => (
              <option key={i.id} value={i.id}>
                {i.label}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Własny cel (opcjonalnie)"
          hint="Wpisany cel zastąpi wybrany powyżej i zostanie zapisany na przyszłość."
        >
          <input maxLength={150} {...register("customIntent")} />
        </Field>
        <details>
          <summary>Inne cele zachowane przez ten sam wariant</summary>
          {data.intents
            .filter((i) => i.id !== watch("intent"))
            .map((i) => (
              <label className="checkbox" key={i.id}>
                <input
                  type="checkbox"
                  checked={extraIntents.includes(i.id)}
                  onChange={(e) =>
                    setExtraIntents(
                      e.target.checked
                        ? [...extraIntents, i.id]
                        : extraIntents.filter((x) => x !== i.id),
                    )
                  }
                />
                {i.label}
              </label>
            ))}
        </details>
        <Field label="Wariant istniejącej aktywności (opcjonalnie)">
          <select disabled={!!editVariant} {...register("templateId")}>
            <option value="">Nowa aktywność</option>
            {data.activities.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="form-grid">
          <Field label="Aktywność (min)">
            <input
              required
              type="number"
              min={1}
              max={1440}
              {...register("duration")}
            />
          </Field>
          <Field label="Przygotowanie (min)">
            <input
              required
              type="number"
              min={0}
              max={1440}
              {...register("preparation")}
            />
          </Field>
          <Field
            label="Dojazd łącznie (min)"
            hint="Puste oznacza brak informacji. Taki wariant czeka na uzupełnienie."
          >
            <input type="number" min={0} max={1440} {...register("travel")} />
          </Field>
          <Field label="Miejsce">
            <input required maxLength={100} {...register("location")} />
          </Field>
        </div>
        <Field
          label="Potrzebny sprzęt (opcjonalnie)"
          hint="Oddziel elementy przecinkiem."
        >
          <input maxLength={300} {...register("equipment")} />
        </Field>
        <Field label="Towarzystwo (opcjonalnie)">
          <input
            placeholder="Np. sam, z Anną, moja grupa"
            maxLength={150}
            {...register("companionship")}
          />
        </Field>
        <Field
          label="Preferowane pory (opcjonalnie)"
          hint="Miękka preferencja, np. 07:30, 18:00. Nie zastępuje dostępnego okna."
        >
          <input {...register("preferred")} />
        </Field>
        {watch("travel") === "" && (
          <Field
            label="Możliwe czasy dojazdu (opcjonalnie)"
            hint="Tylko znane Ci możliwości, np. 10, 30. Aplikacja zapyta, jeśli odpowiedź zmienia wybór."
          >
            <input {...register("travelOptions")} />
          </Field>
        )}
        <label className="checkbox">
          <input type="checkbox" {...register("schedule")} /> Zaplanuj ten
          wariant w dostępnym oknie
        </label>
        {watch("schedule") && (
          <div className="form-grid">
            <Field label="Początek">
              <input required type="datetime-local" {...register("start")} />
            </Field>
            <Field label="Dostępne okno (min)">
              <input
                required
                type="number"
                min={1}
                max={1440}
                {...register("window")}
              />
            </Field>
          </div>
        )}
        <label className="checkbox">
          <input required type="checkbox" /> Znam tę aktywność i potwierdzam
          dostęp do nowo wpisanego miejsca i sprzętu.
        </label>
        <Button type="submit" className="primary" isDisabled={busy}>
          {editVariant ? "Zapisz wariant" : "Zapisz aktywność"}
        </Button>
      </form>
    </DialogBox>
  );
}

export default function Week(props: ViewProps) {
  const { data, update, notify } = props;
  const [calendarView, setCalendarView] = useState(false);
  const [activity, setActivity] = useState(false),
    [editing, setEditing] = useState<ActivityVariant>(),
    [form, setForm] = useState(false),
    [kind, setKind] = useState("work"),
    [label, setLabel] = useState(""),
    [start, setStart] = useState(localInput(now(), data.profile.timezone)),
    [end, setEnd] = useState(
      localInput(
        new Date(Date.now() + 3600000).toISOString(),
        data.profile.timezone,
      ),
    ),
    [resource, setResource] = useState<Resource>(),
    [resourceStatus, setResourceStatus] =
      useState<Resource["status"]>("available"),
    [resourceLimited, setResourceLimited] = useState(false),
    [resourceWindows, setResourceWindows] = useState<Resource["windows"]>([]),
    [intentName, setIntentName] = useState("");
  const priorities = [
    ...data.profile.priorities,
    ...(Object.keys(priorityLabels) as Priority[]).filter(
      (p) => !data.profile.priorities.includes(p),
    ),
  ];
  async function save(next: typeof data, message?: string) {
    try {
      await update(next);
      if (message) notify(message);
      return true;
    } catch (e) {
      notify(errorText(e));
      return false;
    }
  }
  function revalidate() {
    return data.plans.map((p) =>
      Date.parse(p.start) > Date.now() && p.status === "accepted"
        ? { ...p, status: "conflict" as const, needsRevalidation: true }
        : p,
    );
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">MIEJSCE NA TO, CO WAŻNE</p>
          <h1>
            Mój tydzień<span>.</span>
          </h1>
          <p>Grafik, odpoczynek i własne działania w jednym miejscu.</p>
        </div>
        <Button className="primary" onPress={() => setForm(true)}>
          <Plus size={18} /> Dodaj przedział
        </Button>
      </div>
      <div className="week-layout">
        <section className="panel">
          <div className="section-top">
            <h2>
              <CalendarDays size={20} /> Najbliższe 7 dni
            </h2>
            <div
              className="button-row"
              aria-label="Sposób prezentacji tygodnia"
            >
              <Button
                className="secondary compact"
                aria-pressed={!calendarView}
                onPress={() => setCalendarView(false)}
              >
                Lista
              </Button>
              <Button
                className="secondary compact"
                aria-pressed={calendarView}
                onPress={() => setCalendarView(true)}
              >
                Kalendarz
              </Button>
            </div>
          </div>
          <div
            className={calendarView ? "week-calendar" : ""}
            role={calendarView ? "region" : undefined}
            aria-label={calendarView ? "Kalendarz siedmiu dni" : undefined}
            tabIndex={calendarView ? 0 : undefined}
          >
            <Timeline data={data} />
          </div>
        </section>
        <aside>
          <section className="panel">
            <h2>Twoje zasady</h2>
            <Field label="Strefa czasowa">
              <select
                value={data.profile.timezone}
                onChange={(e) =>
                  void save({
                    ...data,
                    profile: { ...data.profile, timezone: e.target.value },
                    revision: data.revision + 1,
                  })
                }
              >
                {[
                  ...new Set([
                    data.profile.timezone,
                    "Europe/Warsaw",
                    "Europe/London",
                    "Europe/Berlin",
                    "America/New_York",
                    "UTC",
                  ]),
                ].map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </Field>
            <Field label="Najważniejsza cecha do zachowania">
              <select
                value={priorities[0]}
                onChange={(e) => {
                  const p = e.target.value as Priority;
                  void save({
                    ...data,
                    profile: {
                      ...data.profile,
                      priorities: [p, ...priorities.filter((x) => x !== p)],
                    },
                    revision: data.revision + 1,
                  });
                }}
              >
                {Object.entries(priorityLabels).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
            <details>
              <summary>Kolejność wszystkich priorytetów</summary>
              <ol>
                {priorities.map((p, index) => (
                  <li key={p}>
                    <div className="source-row">
                      <span>{priorityLabels[p]}</span>
                      <div className="button-row">
                        {[-1, 1].map((direction) => (
                          <Button
                            key={direction}
                            className="icon-button"
                            aria-label={`${direction < 0 ? "Zwiększ" : "Zmniejsz"} priorytet: ${priorityLabels[p]}`}
                            isDisabled={
                              index + direction < 0 ||
                              index + direction >= priorities.length
                            }
                            onPress={() => {
                              const order = [...priorities];
                              [order[index], order[index + direction]] = [
                                order[index + direction]!,
                                order[index]!,
                              ];
                              void save({
                                ...data,
                                profile: { ...data.profile, priorities: order },
                                revision: data.revision + 1,
                              });
                            }}
                          >
                            {direction < 0 ? (
                              <ArrowUp size={16} />
                            ) : (
                              <ArrowDown size={16} />
                            )}
                          </Button>
                        ))}
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            </details>
            <p className="caption">
              Preferencja wpływa na kolejność. Chroniony odpoczynek i
              ograniczenia zawsze obowiązują.
            </p>
            <Button
              className="secondary full"
              onPress={() => setActivity(true)}
            >
              Dodaj aktywność lub wariant
            </Button>
          </section>
          <section className="panel">
            <h2>Twoje znane warianty</h2>
            {data.activities
              .flatMap((a) => a.variants)
              .map((v) => (
                <div className="source-row" key={v.id}>
                  <div>
                    <strong>{v.name}</strong>
                    <small>
                      {v.durationMinutes} min czynności ·{" "}
                      {v.travelMinutes === null
                        ? "brak czasu dojazdu"
                        : `${v.travelMinutes} min dojazdu`}
                    </small>
                    {v.sourceId && (
                      <small>
                        Źródło:{" "}
                        {data.sources.find((s) => s.id === v.sourceId)?.name ??
                          "własny wpis"}
                      </small>
                    )}
                  </div>
                  <Button
                    className="icon-button"
                    aria-label={`Edytuj wariant ${v.name}`}
                    onPress={() => setEditing(v)}
                  >
                    <Pencil size={16} />
                  </Button>
                </div>
              ))}
          </section>
          <section className="panel">
            <h2>Twoje cele</h2>
            <ul>
              {data.intents.map((i) => (
                <li key={i.id}>{i.label}</li>
              ))}
            </ul>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (!intentName.trim()) return;
                const saved = await save(
                  {
                    ...data,
                    revision: data.revision + 1,
                    intents: [
                      ...data.intents,
                      { id: uid(), label: intentName.trim() },
                    ],
                  },
                  "Własny cel został zapisany.",
                );
                if (saved) setIntentName("");
              }}
            >
              <Field label="Nowy własny cel">
                <input
                  required
                  maxLength={150}
                  value={intentName}
                  onChange={(e) => setIntentName(e.target.value)}
                />
              </Field>
              <Button type="submit" className="secondary">
                Dodaj cel
              </Button>
            </form>
          </section>
          <section className="panel">
            <h2>Miejsca i sprzęt</h2>
            <p className="caption">
              Dostępność zasobu jest warunkiem. Brak informacji nie oznacza
              potwierdzenia.
            </p>
            {data.resources.map((r) => (
              <div className="source-row" key={r.id}>
                <div>
                  <strong>{r.label}</strong>
                  <small>
                    {r.status === "available"
                      ? "Dostępne"
                      : r.status === "unavailable"
                        ? "Niedostępne"
                        : "Brak informacji"}
                    {r.windows
                      ? ` · ${r.windows.length} okien dostępności`
                      : ""}
                  </small>
                </div>
                <Button
                  className="icon-button"
                  aria-label={`Edytuj dostępność ${r.label}`}
                  onPress={() => {
                    setResource(r);
                    setResourceStatus(r.status);
                    setResourceLimited(!!r.windows);
                    setResourceWindows(r.windows ?? []);
                  }}
                >
                  <Pencil size={16} />
                </Button>
              </div>
            ))}
          </section>
          <section className="panel">
            <h2>Dostępność i zajęty czas</h2>
            {[...data.availability, ...data.busy, ...data.protectedWindows].map(
              (w) => (
                <div className="source-row" key={w.id}>
                  <div>
                    <strong>
                      {w.label ??
                        (w.kind === "available"
                          ? "Dostępne okno"
                          : w.kind === "rest"
                            ? "Chroniony odpoczynek"
                            : "Zajęty czas")}
                    </strong>
                    <small>
                      {DateTime.fromISO(w.start, {
                        zone: data.profile.timezone,
                      }).toFormat("dd.LL HH:mm")}{" "}
                      →{" "}
                      {DateTime.fromISO(w.end, {
                        zone: data.profile.timezone,
                      }).toFormat("dd.LL HH:mm")}
                    </small>
                  </div>
                  <Button
                    className="icon-button"
                    aria-label={`Usuń przedział ${w.label ?? w.id}`}
                    onPress={() =>
                      void save({
                        ...data,
                        revision: data.revision + 1,
                        availability: data.availability.filter(
                          (x) => x.id !== w.id,
                        ),
                        busy: data.busy.filter((x) => x.id !== w.id),
                        protectedWindows: data.protectedWindows.filter(
                          (x) => x.id !== w.id,
                        ),
                        plans: revalidate(),
                      })
                    }
                  >
                    <Trash2 size={16} />
                  </Button>
                </div>
              ),
            )}
          </section>
        </aside>
      </div>
      {(activity || editing) && (
        <ActivityForm
          {...props}
          editVariant={editing}
          onClose={() => {
            setActivity(false);
            setEditing(undefined);
          }}
        />
      )}
      {resource && (
        <DialogBox
          title={`Dostępność: ${resource.label}`}
          onClose={() => setResource(undefined)}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (resourceLimited && !resourceWindows?.length) {
                notify(
                  "Dodaj przynajmniej jedno okno dostępności lub wyłącz ograniczenie godzin.",
                );
                return;
              }
              try {
                await update({
                  ...data,
                  revision: data.revision + 1,
                  resources: data.resources.map((r) =>
                    r.id === resource.id
                      ? {
                          ...r,
                          status: resourceStatus,
                          windows: resourceLimited
                            ? resourceWindows
                            : undefined,
                        }
                      : r,
                  ),
                  plans: revalidate(),
                });
                setResource(undefined);
                notify(
                  "Dostępność zapisana. Sprawdź powiązane przyszłe zamiary.",
                );
              } catch (err) {
                notify(errorText(err));
              }
            }}
          >
            <Field label="Stan dostępności">
              <select
                value={resourceStatus}
                onChange={(e) =>
                  setResourceStatus(e.target.value as Resource["status"])
                }
              >
                <option value="available">Dostępne</option>
                <option value="unavailable">Niedostępne</option>
                <option value="unknown">Nie wiem</option>
              </select>
            </Field>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={resourceLimited}
                onChange={(e) => setResourceLimited(e.target.checked)}
              />{" "}
              Dostępne tylko w określonych godzinach
            </label>
            {resourceLimited && (
              <>
                {resourceWindows?.map((w) => (
                  <div className="source-row" key={w.id}>
                    <span>
                      {localInput(w.start, data.profile.timezone)} →{" "}
                      {localInput(w.end, data.profile.timezone)}
                    </span>
                    <Button
                      className="icon-button"
                      aria-label="Usuń okno zasobu"
                      onPress={() =>
                        setResourceWindows(
                          resourceWindows.filter((x) => x.id !== w.id),
                        )
                      }
                    >
                      <Trash2 size={16} />
                    </Button>
                  </div>
                ))}
                <Field label="Zasób dostępny od">
                  <input
                    type="datetime-local"
                    value={start}
                    onChange={(e) => setStart(e.target.value)}
                  />
                </Field>
                <Field label="Zasób dostępny do">
                  <input
                    type="datetime-local"
                    value={end}
                    onChange={(e) => setEnd(e.target.value)}
                  />
                </Field>
                <Button
                  className="secondary"
                  onPress={() => {
                    try {
                      const s = fromLocal(start, data.profile.timezone),
                        t = fromLocal(end, data.profile.timezone);
                      if (t <= s)
                        throw Error("Koniec musi być późniejszy od początku.");
                      setResourceWindows([
                        ...(resourceWindows ?? []),
                        {
                          id: uid(),
                          start: s,
                          end: t,
                          timezone: data.profile.timezone,
                        },
                      ]);
                    } catch (e) {
                      notify(errorText(e));
                    }
                  }}
                >
                  Dodaj okno zasobu
                </Button>
              </>
            )}
            <Button type="submit" className="primary">
              Zapisz dostępność
            </Button>
          </form>
        </DialogBox>
      )}
      {form && (
        <DialogBox
          title="Dodaj przedział w grafiku"
          onClose={() => setForm(false)}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                const s = fromLocal(start, data.profile.timezone),
                  t = fromLocal(end, data.profile.timezone);
                if (t <= s)
                  throw Error(
                    "Koniec musi być późniejszy od początku. Przy nocnej zmianie wybierz następny dzień.",
                  );
                const interval = {
                  id: uid(),
                  start: s,
                  end: t,
                  originalLocalStart: start,
                  originalLocalEnd: end,
                  timezone: data.profile.timezone,
                  label,
                  kind: kind as "work" | "rest" | "available" | "buffer",
                };
                const key =
                  kind === "rest"
                    ? "protectedWindows"
                    : kind === "available"
                      ? "availability"
                      : "busy";
                await update({
                  ...data,
                  [key]: [...data[key], interval],
                  plans: revalidate(),
                  revision: data.revision + 1,
                });
                setForm(false);
                notify("Przedział został zapisany.");
              } catch (err) {
                notify(errorText(err));
              }
            }}
          >
            <Field label="Rodzaj">
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="work">Praca / zmiana</option>
                <option value="rest">Chroniony odpoczynek</option>
                <option value="available">Dostępne okno</option>
                <option value="buffer">Dojazd / bufor</option>
              </select>
            </Field>
            <Field label="Nazwa">
              <input
                required
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </Field>
            <Field label="Początek">
              <input
                required
                type="datetime-local"
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </Field>
            <Field label="Koniec">
              <input
                required
                type="datetime-local"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
              />
            </Field>
            <Button type="submit" className="primary">
              Zapisz przedział
            </Button>
          </form>
        </DialogBox>
      )}
    </>
  );
}
