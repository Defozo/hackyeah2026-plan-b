import { checkAbort, ImportError, stableId } from "./common";
import { parsePolishNumber } from "./csv";
import type {
  DocumentFact,
  DocumentPage,
  ImportOptions,
  ImportSource,
  ParsedImport,
} from "./types";

class LocalCanvasFactory {
  create(width: number, height: number) {
    const canvas = new OffscreenCanvas(width, height);
    return { canvas, context: canvas.getContext("2d")! };
  }
  reset(entry: { canvas: OffscreenCanvas }, width: number, height: number) {
    entry.canvas.width = width;
    entry.canvas.height = height;
  }
  destroy(entry: { canvas: OffscreenCanvas | null; context?: unknown }) {
    if (entry.canvas) {
      entry.canvas.width = 0;
      entry.canvas.height = 0;
    }
    entry.canvas = null;
    entry.context = null;
  }
}
// Same DOM-free filter behavior as PDF.js NodeFilterFactory. Original bytes are
// always preserved; this raster is only a local OCR/reference preview.
class LocalFilterFactory {
  addFilter() {
    return "none";
  }
  addHCMFilter() {
    return "none";
  }
  addAlphaFilter() {
    return "none";
  }
  addLuminosityFilter() {
    return "none";
  }
  addHighlightHCMFilter() {
    return "none";
  }
  destroy() {}
}

export function factsFromPage(page: DocumentPage): DocumentFact[] {
  return page.text
    .split(/\n+/)
    .map((text) => text.trim())
    .filter(Boolean)
    .map((text, index) => {
      // Extraction proposes literal fields only. No medical norms or values are invented.
      const numeric = text.match(
        /^([^:=]+?)\s*[:=]\s*([+-]?\d+(?:[.,]\d+)?)\s*([^\s;()[\]\d:+-][^\s;()[\]]*)?(?:\s*\((?:norma|zakres)\s*:?\s*([^)]*)\))?$/i,
      );
      const date = text.match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1];
      const result: DocumentFact = {
        id: `fact-${stableId(`${page.sourceId}|${page.page}|${index}|${text}`)}`,
        sourceId: page.sourceId,
        page: page.page,
        label: numeric?.[1]?.trim() || "Fragment dokumentu",
        text,
        originalText: text,
        status: "pending",
        extraction: page.extraction,
        version: 1,
        ...(page.confidence !== undefined
          ? { confidence: page.confidence }
          : {}),
        ...(date ? { date } : {}),
      };
      if (numeric) {
        result.value = parsePolishNumber(numeric[2]!);
        if (numeric[3]) result.unit = numeric[3];
        if (numeric[4]) result.referenceRange = numeric[4];
      }
      return result;
    });
}
export function reviewFact(
  fact: DocumentFact,
  patch: Partial<
    Pick<
      DocumentFact,
      "label" | "text" | "value" | "unit" | "referenceRange" | "date"
    >
  >,
  status: DocumentFact["status"],
): DocumentFact {
  if (patch.value !== undefined && !Number.isFinite(patch.value))
    throw new ImportError("INVALID_FACT_VALUE", "Podaj poprawną wartość pola.");
  // Correcting the literal invalidates a numeric extraction from the old text.
  const derived =
    patch.text !== undefined && patch.text !== fact.text
      ? { value: undefined }
      : {};
  return { ...fact, ...derived, ...patch, status, version: fact.version + 1 };
}
export async function extractDocument(
  data: Uint8Array,
  mimeType: string,
  source: ImportSource,
  options: ImportOptions = {},
): Promise<ParsedImport> {
  checkAbort(options.signal);
  const base = (options.assetBase ?? "/assets").replace(/\/$/, "");
  const pages: DocumentPage[] = [];
  let ocr:
    | Awaited<ReturnType<(typeof import("tesseract.js"))["createWorker"]>>
    | undefined;
  const stopOCR = () => {
    void ocr?.terminate();
  };
  options.signal?.addEventListener("abort", stopOCR, { once: true });
  const recognize = async (image: Uint8Array, imageType: string) => {
    checkAbort(options.signal);
    if (!ocr) {
      const { createWorker, OEM } = await import("tesseract.js");
      ocr = await createWorker(["pol", "eng"], OEM.LSTM_ONLY, {
        workerPath: `${base}/ocr/worker.min.js`,
        corePath: `${base}/ocr/core`,
        langPath: `${base}/ocr/lang`,
        workerBlobURL: false,
        gzip: true,
        cacheMethod: "none",
        logger: (m) =>
          options.onProgress?.({
            stage: "OCR: " + m.status,
            progress: m.progress ?? 0,
          }),
      });
    }
    checkAbort(options.signal);
    const result = await ocr.recognize(
      new Blob([new Uint8Array(image).buffer], { type: imageType }),
    );
    checkAbort(options.signal);
    return result.data;
  };
  try {
    if (mimeType === "application/pdf") {
      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = `${base}/pdf/pdf.worker.min.mjs`;
      const origin = self.location.origin;
      const pdfWorkerPort = new Worker(
        new URL(`${base}/pdf/pdf.worker.min.mjs`, origin),
        { type: "module" },
      );
      // PDF.js 6 infers the JS default port:null too narrowly in its .d.ts.
      const pdfWorker = new pdfjs.PDFWorker({
        port: pdfWorkerPort,
      } as unknown as ConstructorParameters<typeof pdfjs.PDFWorker>[0]);
      const task = pdfjs.getDocument({
        data: new Uint8Array(data),
        worker: pdfWorker,
        cMapUrl: new URL(`${base}/pdf/cmaps/`, origin).href,
        cMapPacked: true,
        standardFontDataUrl: new URL(`${base}/pdf/standard_fonts/`, origin)
          .href,
        wasmUrl: new URL(`${base}/pdf/wasm/`, origin).href,
        useWorkerFetch: true,
        disableFontFace: true,
        useSystemFonts: false,
        CanvasFactory: LocalCanvasFactory,
        FilterFactory: LocalFilterFactory,
      });
      const abortPDF = () => {
        void task.destroy();
      };
      options.signal?.addEventListener("abort", abortPDF, { once: true });
      try {
        const document = await task.promise;
        if (document.numPages > (options.maxPages ?? 20))
          throw new ImportError(
            "PDF_PAGE_LIMIT",
            "Dokument przekracza limit 20 stron. Podziel go na mniejsze pliki.",
          );
        for (let number = 1; number <= document.numPages; number++) {
          checkAbort(options.signal);
          options.onProgress?.({
            stage: `Strona ${number} z ${document.numPages}`,
            progress: (number - 1) / document.numPages,
          });
          const page = await document.getPage(number);
          const content = await page.getTextContent();
          let text = "";
          for (const item of content.items)
            if ("str" in item) text += item.str + (item.hasEOL ? "\n" : " ");
          const viewport = page.getViewport({ scale: 1.6 });
          if (viewport.width * viewport.height > 20_000_000)
            throw new ImportError(
              "IMAGE_DIMENSIONS",
              "Strona ma zbyt duże wymiary. Zmniejsz rozdzielczość dokumentu.",
            );
          const canvas = new OffscreenCanvas(
            Math.ceil(viewport.width),
            Math.ceil(viewport.height),
          );
          const context = canvas.getContext("2d");
          if (!context)
            throw new ImportError(
              "CANVAS_UNAVAILABLE",
              "Przeglądarka nie udostępnia lokalnego renderowania dokumentów. Użyj aktualnej przeglądarki lub wpisz dane ręcznie.",
            );
          await page.render({
            canvas: canvas as unknown as HTMLCanvasElement,
            canvasContext: context as unknown as CanvasRenderingContext2D,
            viewport,
          }).promise;
          const image = new Uint8Array(
            await (
              await canvas.convertToBlob({ type: "image/png" })
            ).arrayBuffer(),
          );
          if (text.trim().length >= 5)
            pages.push({
              page: number,
              sourceId: source.id,
              text: text.trim(),
              extraction: "text",
              image,
              imageType: "image/png",
            });
          else {
            const recognized = await recognize(image, "image/png");
            pages.push({
              page: number,
              sourceId: source.id,
              text: recognized.text,
              extraction: "ocr",
              confidence: recognized.confidence,
              image,
              imageType: "image/png",
            });
          }
          page.cleanup();
        }
      } finally {
        options.signal?.removeEventListener("abort", abortPDF);
        await task.destroy();
        pdfWorker.destroy();
        pdfWorkerPort.terminate();
      }
    } else {
      const bitmap = await createImageBitmap(
        new Blob([new Uint8Array(data).buffer], { type: mimeType }),
      );
      const pixels = bitmap.width * bitmap.height;
      bitmap.close();
      if (pixels > 20_000_000)
        throw new ImportError(
          "IMAGE_DIMENSIONS",
          "Obraz ma zbyt dużą rozdzielczość. Zmniejsz go do 20 megapikseli.",
        );
      const result = await recognize(data, mimeType);
      pages.push({
        page: 1,
        sourceId: source.id,
        text: result.text,
        extraction: "ocr",
        confidence: result.confidence,
        image: new Uint8Array(data),
        imageType: mimeType,
      });
    }
    const facts = pages.flatMap(factsFromPage);
    return {
      pages,
      facts,
      issues: facts.length
        ? []
        : [
            {
              code: "NO_TEXT",
              severity: "warning",
              message:
                "Nie odczytano tekstu. Możesz przepisać pola z oryginału lub dodać wyraźniejszy plik.",
            },
          ],
      complete: true,
    };
  } catch (error) {
    checkAbort(options.signal);
    if (error instanceof ImportError) throw error;
    const message = error instanceof Error ? error.message : "";
    if (/password/i.test(message))
      throw new ImportError(
        "ENCRYPTED_PDF",
        "Ten PDF jest zabezpieczony hasłem. Utwórz lokalną kopię bez zabezpieczenia lub przepisz wybrane pola.",
      );
    throw new ImportError(
      "DOCUMENT_FAILED",
      "Nie udało się odczytać dokumentu lokalnie. Sprawdź plik i pobranie zasobów OCR; możesz też wpisać pola ręcznie.",
    );
  } finally {
    options.signal?.removeEventListener("abort", stopOCR);
    await ocr?.terminate();
  }
}
