export type OfflineState =
  "preparing" | "ready" | "unavailable" | "update" | "development";
let current: OfflineState = import.meta.env.PROD ? "preparing" : "development";
let registration: ServiceWorkerRegistration | undefined;
function announce(state: OfflineState) {
  current = state;
  window.dispatchEvent(new CustomEvent("planb-offline", { detail: state }));
}
export function offlineState() {
  return current;
}
export async function activateUpdate() {
  registration?.waiting?.postMessage("ACTIVATE_UPDATE");
}
export async function prepareOffline() {
  if (!import.meta.env.PROD) return;
  if (!("serviceWorker" in navigator)) {
    announce("unavailable");
    return;
  }
  try {
    registration = await navigator.serviceWorker.register("/sw.js");
    if (registration.waiting) announce("update");
    else if (registration.active) announce("ready");
    registration.addEventListener("updatefound", () => {
      const worker = registration!.installing;
      worker?.addEventListener("statechange", () => {
        if (worker.state === "installed")
          announce(navigator.serviceWorker.controller ? "update" : "ready");
        if (worker.state === "redundant") announce("unavailable");
      });
    });
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (current === "update") location.reload();
      else announce("ready");
    });
    await navigator.serviceWorker.ready;
    if (current !== "update") announce("ready");
  } catch {
    announce("unavailable");
  }
}
