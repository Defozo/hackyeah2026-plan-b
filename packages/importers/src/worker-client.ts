import type { ImportFile, ImportOptions, ImportPreview } from "./types";
import { ImportError } from "./common";

const running = new Set<() => void>();
export function cancelAllImports() {
  for (const cancel of [...running]) cancel();
}
export function startImport(
  file: File | ImportFile,
  options: ImportOptions = {},
): { promise: Promise<ImportPreview>; cancel: () => void } {
  let cancel = () => {};
  const promise = new Promise<ImportPreview>((resolve, reject) => {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    });
    let done = false;
    const cleanup = () => {
      done = true;
      worker.terminate();
      running.delete(cancel);
      options.signal?.removeEventListener("abort", cancel);
    };
    cancel = () => {
      if (done) return;
      cleanup();
      reject(new DOMException("Import anulowany.", "AbortError"));
    };
    running.add(cancel);
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) {
      cancel();
      return;
    }
    worker.onmessage = (event) => {
      if (event.data.type === "progress")
        options.onProgress?.(event.data.progress);
      else if (event.data.type === "result") {
        cleanup();
        resolve(event.data.result as ImportPreview);
      } else if (event.data.type === "error") {
        cleanup();
        reject(
          new ImportError(
            event.data.code ?? "IMPORT_FAILED",
            event.data.message,
          ),
        );
      }
    };
    worker.onerror = () => {
      cleanup();
      reject(
        new ImportError(
          "WORKER_FAILED",
          "Nie udało się uruchomić lokalnego importu. Dane nie zostały zapisane.",
        ),
      );
    };
    const {
      signal: _signal,
      onProgress: _progress,
      ...serializableOptions
    } = options;
    worker.postMessage({ file, options: serializableOptions });
  });
  return { promise, cancel: () => cancel() };
}
