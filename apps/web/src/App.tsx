import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  CalendarDays,
  ChartNoAxesColumn,
  HeartHandshake,
  House,
  LockKeyhole,
  ShieldCheck,
  ArrowUpRight,
  Leaf,
  WifiOff,
} from "lucide-react";
import { createDemoData, type DomainData } from "@planb/domain";
import { Vault, type AppData } from "./vault";
import { Button, Field } from "./components";
import { errorText } from "./utils";
import Today from "./Today";
import {
  offlineState,
  activateUpdate,
  prepareOffline,
  type OfflineState,
} from "./offline";
import { cancelAllImports } from "@planb/importers";
const Week = lazy(() => import("./Week"));
const History = lazy(() => import("./History"));
const Care = lazy(() => import("./Care"));
const DataView = lazy(() => import("./DataView"));
export interface ViewProps {
  data: AppData;
  update: (next: AppData) => Promise<void>;
  notify: (message: string) => void;
}
const DEMO_PHRASE = "synthetic-planb-demo-only";
const views = [
  { id: "today", label: "Dzisiaj", icon: House },
  { id: "week", label: "Mój tydzień", icon: CalendarDays },
  { id: "history", label: "Historia", icon: ChartNoAxesColumn },
  { id: "care", label: "Przed wizytą", icon: HeartHandshake },
  { id: "data", label: "Moje dane", icon: ShieldCheck },
];
function enrich(d: DomainData): AppData {
  return {
    ...d,
    schemaVersion: 1,
    attachments: [],
    importedKeys: [],
    reminders: false,
  };
}
export default function App() {
  const [data, setData] = useState<AppData | null>(null),
    [mode, setMode] = useState<"demo" | "personal">("personal"),
    [view, setView] = useState("today"),
    [phrase, setPhrase] = useState(""),
    [exists, setExists] = useState(false),
    [notice, setNotice] = useState(""),
    [working, setWorking] = useState(false),
    [online, setOnline] = useState(navigator.onLine);
  const [offline, setOffline] = useState<OfflineState>(offlineState());
  useEffect(() => {
    const receive = (event: Event) =>
      setOffline((event as CustomEvent<OfflineState>).detail);
    window.addEventListener("planb-offline", receive);
    return () => window.removeEventListener("planb-offline", receive);
  }, []);
  const vault = useRef(new Vault("personal"));
  const gate = useRef(false);
  useEffect(() => {
    void vault.current.exists().then(setExists);
    const on = () => setOnline(navigator.onLine);
    window.addEventListener("online", on);
    window.addEventListener("offline", on);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", on);
    };
  }, []);
  async function openDemo() {
    setWorking(true);
    try {
      vault.current.lock();
      vault.current = new Vault("demo");
      const d = (await vault.current.exists())
        ? await vault.current.unlock(DEMO_PHRASE)
        : await vault.current.create(DEMO_PHRASE, enrich(createDemoData()));
      setMode("demo");
      setData(d);
      setView("today");
      setNotice("Przykład i historia zawierają wyłącznie dane syntetyczne.");
    } catch (e) {
      setNotice(errorText(e));
    } finally {
      setWorking(false);
    }
  }
  async function openPersonal() {
    setWorking(true);
    try {
      vault.current.lock();
      vault.current = new Vault("personal");
      let d: AppData;
      if (await vault.current.exists()) {
        d = await vault.current.unlock(phrase);
      } else {
        const base = enrich(createDemoData());
        d = {
          ...base,
          profile: {
            ...base.profile,
            id: crypto.randomUUID(),
            mode: "personal",
          },
          activities: [],
          plans: [],
          availability: [],
          busy: [],
          protectedWindows: [],
          constraints: [],
          resources: [],
          decisions: [],
          outcomes: [],
          revisions: [],
          observations: [],
          documentFacts: [],
          sources: [],
          carePackets: [],
          consents: [],
          exports: [],
          revision: 0,
        };
        await vault.current.create(phrase, d);
      }
      setMode("personal");
      setData(d);
      setPhrase("");
      setView("today");
      setNotice(
        "Sejf jest odblokowany. Dane są zapisywane tylko na tym urządzeniu.",
      );
    } catch (e) {
      setNotice(errorText(e));
    } finally {
      setWorking(false);
    }
  }
  async function update(next: AppData) {
    if (gate.current) throw Error("Trwa zapis poprzedniej zmiany.");
    gate.current = true;
    const activeVault = vault.current;
    try {
      await activeVault.save(next);
      // A completed encrypted write must never reopen a profile that was locked meanwhile.
      if (vault.current === activeVault) setData(next);
    } catch (e) {
      if (vault.current === activeVault) setNotice(errorText(e));
      throw e;
    } finally {
      gate.current = false;
    }
  }
  async function lock() {
    cancelAllImports();
    vault.current.lock();
    setData(null);
    setPhrase("");
    setNotice("Sejf został zablokowany.");
    vault.current = new Vault("personal");
    setExists(await vault.current.exists());
  }
  const notify = (message: string) => {
    setNotice(message);
    window.dispatchEvent(new CustomEvent("planb-notice", { detail: message }));
  };
  const props = data ? { data, update, notify } : null;
  if (!data)
    return (
      <div className="welcome">
        <header className="brand">
          <span className="brand-mark">B</span>
          <span>
            plan b<span className="brand-dot">.</span>
          </span>
        </header>
        <main className="welcome-grid">
          <section>
            <p className="eyebrow">TWOJE ŻYCIE. TWÓJ RYTM.</p>
            <h1>
              Dzień się zmienia.
              <br />
              <span>Twój zamiar zostaje.</span>
            </h1>
            <p className="intro">
              Mniej czasu, inna zmiana, potrzeba odpoczynku. Znajdź następny
              krok, który pasuje do Ciebie, i zobacz, co zachowujesz ze swojego
              planu.
            </p>
            <Button className="primary" onPress={openDemo} isDisabled={working}>
              Zobacz przykład <ArrowUpRight size={20} />
            </Button>
            <div className="welcome-proof">
              <Leaf size={20} />
              <span>
                Bez presji. Bez obowiązkowego konta.
                <br />
                Również bez połączenia z internetem.
              </span>
            </div>
          </section>
          <section className="onboarding panel">
            <span className="tag">
              <LockKeyhole size={15} /> Twój prywatny sejf
            </span>
            <h2>{exists ? "Witaj z powrotem" : "Zacznij od własnego planu"}</h2>
            <p>
              {exists
                ? "Podaj frazę, aby odblokować zapis na tym urządzeniu."
                : "Jedna znana aktywność wystarczy. Fraza chroni Twój lokalny zapis."}
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void openPersonal();
              }}
            >
              <Field
                label="Fraza sejfu"
                hint="Co najmniej 12 znaków. Zapomnianej frazy nie możemy odzyskać."
              >
                <input
                  type="password"
                  autoComplete={exists ? "current-password" : "new-password"}
                  value={phrase}
                  minLength={12}
                  required
                  onChange={(e) => setPhrase(e.target.value)}
                />
              </Field>
              <Button
                type="submit"
                className="primary full"
                isDisabled={working}
              >
                {working
                  ? "Otwieram sejf…"
                  : exists
                    ? "Odblokuj sejf"
                    : "Utwórz sejf"}
              </Button>
            </form>
            <p className="caption">
              Po pierwszym zapisie pobierz zaszyfrowaną kopię. Usunięcie danych
              przeglądarki usuwa też lokalny sejf.
            </p>
            <details>
              <summary>Mam kopię sejfu</summary>
              <Field label="Kopia .json">
                <input
                  type="file"
                  accept=".json"
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    try {
                      const v = new Vault("personal");
                      const restored = await v.restore(await f.text(), phrase);
                      vault.current = v;
                      setData(restored);
                      setMode("personal");
                      setPhrase("");
                    } catch (err) {
                      setNotice(errorText(err));
                    }
                  }}
                />
              </Field>
              <small>
                Najpierw podaj powyżej frazę używaną do utworzenia kopii.
                Poprawna kopia zastąpi obecny sejf.
              </small>
            </details>
          </section>
        </main>
        {notice && (
          <div role="status" className="welcome-status">
            {notice}
          </div>
        )}
        <footer>
          Plan B pomaga organizować własne działania i przygotować rozmowę ze
          specjalistą.
        </footer>
      </div>
    );
  return (
    <div className="shell">
      <a className="skip" href="#main">
        Przejdź do treści
      </a>
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setView("today");
          }}
        >
          <span className="brand-mark">B</span>
          <span>
            plan b<span className="brand-dot">.</span>
          </span>
        </a>
        <p className="sidebar-caption">PLAN, KTÓRY MOŻNA ZMIENIĆ</p>
        <nav aria-label="Główna nawigacja">
          {views.map((v) => (
            <Button
              key={v.id}
              className={`nav-item ${view === v.id ? "active" : ""}`}
              aria-current={view === v.id ? "page" : undefined}
              onPress={() => setView(v.id)}
            >
              <v.icon size={21} />
              <span>{v.label}</span>
              {view === v.id && <span className="nav-dot" />}
            </Button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <Leaf size={25} />
          <p>
            Mały krok też
            <br />
            ma znaczenie.
          </p>
          <span className="caption">
            Dopasuj plan do dnia.
            <br />
            Daj sobie przestrzeń.
          </span>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <span className="breadcrumb">
            Twój plan <span>/</span> {views.find((v) => v.id === view)?.label}
          </span>
          <div className="top-actions">
            {offline === "ready" && <span className="tag">Gotowe offline</span>}
            {offline === "preparing" && (
              <span className="tag">Pobieram zasoby offline…</span>
            )}
            {offline === "update" && (
              <Button
                className="text-button"
                onPress={() => void activateUpdate()}
              >
                Nowa wersja: wczytaj
              </Button>
            )}
            {offline === "unavailable" && (
              <Button
                className="text-button"
                onPress={() => void prepareOffline()}
              >
                Ponów pobieranie offline
              </Button>
            )}
            {!online && (
              <span className="tag offline">
                <WifiOff size={14} /> Bez sieci
              </span>
            )}
            <span className="tag">
              {mode === "demo" ? "Dane syntetyczne" : "Zapis na urządzeniu"}
            </span>
            <Button
              className="icon-button"
              aria-label="Zablokuj sejf"
              onPress={() => void lock()}
            >
              <LockKeyhole size={18} />
            </Button>
          </div>
        </header>
        <main id="main" className="content" tabIndex={-1}>
          {notice && (
            <div role="status" className="notice">
              <span>{notice}</span>
              <Button
                className="text-button"
                aria-label="Zamknij powiadomienie"
                onPress={() => setNotice("")}
              >
                ×
              </Button>
            </div>
          )}
          <Suspense fallback={<p role="status">Otwieram widok…</p>}>
            {view === "today" && <Today {...props!} />}{" "}
            {view === "week" && <Week {...props!} />}{" "}
            {view === "history" && <History {...props!} />}{" "}
            {view === "care" && <Care {...props!} />}{" "}
            {view === "data" && (
              <DataView
                {...props!}
                vault={vault.current}
                lock={lock}
                resetDemo={async () => {
                  await update(enrich(createDemoData()));
                  setNotice("Przykład został odtworzony.");
                }}
              />
            )}
          </Suspense>
        </main>
        <footer className="app-footer">
          <ShieldCheck size={15} />{" "}
          {mode === "demo"
            ? "Osobny sejf demonstracyjny"
            : "Twoje dane pozostają na tym urządzeniu"}
          <span>Twoja decyzja. Twój następny krok.</span>
        </footer>
      </div>
    </div>
  );
}
