import { repairPlan, type RepairInput } from "@planb/domain";
self.onmessage = (event: MessageEvent<RepairInput>) => {
  try {
    self.postMessage({ result: repairPlan(event.data) });
  } catch (e) {
    self.postMessage({
      error: e instanceof Error ? e.message : "Błąd przeliczenia",
    });
  }
};
