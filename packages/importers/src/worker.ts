import { previewImport } from "./core";
import type { ImportFile, ImportOptions } from "./types";

self.onmessage = async (
  event: MessageEvent<{ file: File | ImportFile; options: ImportOptions }>,
) => {
  try {
    const result = await previewImport(event.data.file, {
      ...event.data.options,
      onProgress: (progress) =>
        self.postMessage({ type: "progress", progress }),
    });
    self.postMessage({ type: "result", result });
  } catch (error) {
    self.postMessage({
      type: "error",
      code:
        error && typeof error === "object" && "code" in error
          ? error.code
          : "IMPORT_FAILED",
      message:
        error instanceof Error
          ? error.message
          : "Nie udało się odczytać pliku.",
    });
  }
};
