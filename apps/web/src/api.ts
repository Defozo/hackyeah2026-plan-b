export interface Capabilities {
  aiEnabled: boolean;
  personalAiEnabled: boolean;
  textDraft: boolean;
  transcription: boolean;
  nfz: boolean;
  csrfToken: string;
  syntheticFixtures: { id: string; label: string; text: string }[];
  audioFixture?: { id: string; text: string; url: string };
}
export async function capabilities(): Promise<Capabilities> {
  const r = await fetch("/api/capabilities", {
    credentials: "same-origin",
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok)
    throw Error(
      "Usługi online są obecnie niedostępne. Funkcje lokalne działają.",
    );
  return r.json();
}
export async function postApi(
  path: string,
  body: unknown,
  csrf: string,
  signal?: AbortSignal,
) {
  const r = await fetch(`/api/${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: JSON.stringify(body),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
      : AbortSignal.timeout(30000),
  });
  const result = await r.json();
  if (!r.ok)
    throw Error(
      result.message ??
        result.error ??
        "Usługa nie odpowiedziała. Możesz nadal wpisać tekst ręcznie.",
    );
  return result;
}
