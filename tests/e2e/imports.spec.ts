import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import type { AppData, Envelope } from "../../apps/web/src/vault";

const phrase = "Syntetyczna fraza importu 2026";
async function nav(page: Page, name: string) {
  await page
    .getByRole("navigation")
    .getByRole("button", { name, exact: true })
    .click();
}
async function personal(page: Page) {
  await page.goto("/");
  await page.getByLabel("Fraza sejfu").fill(phrase);
  await page.getByRole("button", { name: "Utwórz sejf", exact: true }).click();
  await nav(page, "Moje dane");
}
async function backup(page: Page): Promise<AppData> {
  const event = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Pobierz kopię sejfu", exact: true })
    .click();
  const envelope: Envelope = JSON.parse(
    await readFile((await (await event).path())!, "utf8"),
  );
  const key = pbkdf2Sync(
    phrase,
    Buffer.from(envelope.kdf.salt, "base64"),
    envelope.kdf.iterations,
    32,
    "sha256",
  );
  const ciphertext = Buffer.from(envelope.ciphertext, "base64"),
    decrypt = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(envelope.iv, "base64"),
    );
  decrypt.setAAD(Buffer.from(`planb-vault:1:${envelope.generation}`));
  decrypt.setAuthTag(ciphertext.subarray(-16));
  return JSON.parse(
    Buffer.concat([
      decrypt.update(ciphertext.subarray(0, -16)),
      decrypt.final(),
    ]).toString("utf8"),
  );
}
async function confirm(page: Page) {
  await page
    .getByRole("button", { name: "Zatwierdź import", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText(
    /Import zapisany|Ta paczka z tą konfiguracją jest już zapisana/,
  );
}
const input = (name: string, text: string, mimeType = "text/csv") => ({
  name,
  mimeType,
  buffer: Buffer.from(text),
});

test("CSV remapping explicitly replaces one packet and preserves another after reload; negative manual steps are rejected", async ({
  page,
}) => {
  await personal(page);
  const first = input(
    "combined.csv",
    "source,external_id,metric,start,value,alternative,unit\nwatch,day-1,steps,2026-10-03T10:00:00Z,10,20,steps",
  );
  const loadCSV = async (file: ReturnType<typeof input>) => {
    await page.getByLabel("Wybierz plik", { exact: true }).setInputFiles(file);
    await page
      .getByRole("button", { name: "Pokaż podgląd CSV", exact: true })
      .click();
  };
  await loadCSV(first);
  await confirm(page);
  const original = await backup(page);
  const sourceId = original.sources[0]!.id;
  await page
    .getByText("Zakres kalendarza i aktualizacja źródła", { exact: true })
    .click();
  await page
    .getByRole("combobox", {
      name: /^Aktualizowany kalendarz lub CSV/,
    })
    .selectOption(sourceId);
  await loadCSV(
    input(
      "another-day.csv",
      "source,external_id,metric,start,value,unit\nwatch,day-2,steps,2026-10-04T10:00:00Z,30,steps",
    ),
  );
  await confirm(page);
  await page.getByLabel("Wybierz plik", { exact: true }).setInputFiles(first);
  await page
    .getByRole("combobox", { name: "value", exact: true })
    .selectOption("alternative");
  await page
    .getByRole("button", { name: "Pokaż podgląd CSV", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    "Zmieniono konfigurację wcześniej zatwierdzonej paczki",
  );
  await expect(page.getByRole("dialog")).toContainText("1 obserwacji");
  await expect(
    page.getByRole("button", { name: "Zatwierdź import", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("checkbox", {
      name: "Sprawdziłem podgląd i potwierdzam zastąpienie rekordów tej paczki oraz ich korekt",
      exact: true,
    })
    .check();
  await confirm(page);
  await page.reload();
  await page.getByLabel(/^Fraza sejfu/).fill(phrase);
  await page
    .getByRole("button", { name: "Odblokuj sejf", exact: true })
    .click();
  await nav(page, "Moje dane");
  const restored = await backup(page);
  expect(
    restored.observations
      .map((o) => o.value)
      .sort((a, b) => Number(a) - Number(b)),
  ).toEqual([20, 30]);
  expect(restored.importBatches!.filter((b) => b.supersededAt)).toHaveLength(1);
  await expect(
    page.getByRole("heading", {
      name: "Zatwierdzone paczki importu",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByLabel("Miara", { exact: true }).fill("steps");
  await page.getByLabel("Wartość obserwacji", { exact: true }).fill("-1");
  await page.getByLabel("Jednostka obserwacji", { exact: true }).fill("steps");
  await page
    .getByLabel("Czas obserwacji", { exact: true })
    .fill("2026-10-05T12:00");
  await page
    .getByRole("button", { name: "Zapisz obserwację", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("nie mogą być ujemne");
  expect((await backup(page)).observations).toEqual(restored.observations);
  await page
    .getByRole("button", { name: "Sprawdź / popraw pomiar", exact: true })
    .first()
    .click();
  await page
    .getByLabel("Poprawiona wartość pomiaru", { exact: true })
    .fill("-2");
  await page
    .getByRole("button", { name: "Zapisz korektę pomiaru", exact: true })
    .click();
  await expect(page.getByRole("dialog").getByRole("status")).toContainText(
    "nie mogą być ujemne",
  );
  await page.getByRole("button", { name: "Zamknij", exact: true }).click();
  expect((await backup(page)).observations).toEqual(restored.observations);
});

test("CSV mapping, Polish number, cancellation, idempotency and cross-file source choice survive reload", async ({
  page,
}) => {
  await personal(page);
  const watch = input(
    "watch-custom.csv",
    "urzadzenie;id;miara;od;do;liczba;jednostka\nwatch;night-1;sleep;2026-10-02T22:00:00Z;2026-10-03T05:30:00Z;7,5;h",
  );
  await page.getByLabel("Wybierz plik", { exact: true }).setInputFiles(watch);
  for (const [field, column] of Object.entries({
    source: "urzadzenie",
    external_id: "id",
    metric: "miara",
    start: "od",
    end: "do",
    value: "liczba",
    unit: "jednostka",
  }))
    await page
      .getByRole("combobox", { name: field, exact: true })
      .selectOption(column);
  await page
    .getByRole("button", { name: "Pokaż podgląd CSV", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("450 min");
  await page
    .getByRole("button", { name: "Anuluj import", exact: true })
    .click();
  expect((await backup(page)).observations).toHaveLength(0);
  await page
    .getByRole("button", { name: "Pokaż podgląd CSV", exact: true })
    .click();
  await confirm(page);
  await page
    .getByRole("button", { name: "Pokaż podgląd CSV", exact: true })
    .click();
  await confirm(page);
  expect((await backup(page)).observations).toHaveLength(1);
  await page
    .getByLabel("Wybierz plik", { exact: true })
    .setInputFiles(
      input(
        "phone.csv",
        "source,external_id,metric,start,end,value,unit\nphone,night-1,sleep,2026-10-02T22:00:00Z,2026-10-03T05:30:00Z,7,h",
      ),
    );
  await page
    .getByRole("button", { name: "Pokaż podgląd CSV", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel(/Źródło nadrzędne: sleep/)
    .selectOption({ label: "watch" });
  await confirm(page);
  expect((await backup(page)).observations.map((o) => o.value)).toEqual([450]);
  await page.reload();
  await page.getByLabel("Fraza sejfu").fill(phrase);
  await page
    .getByRole("button", { name: "Odblokuj sejf", exact: true })
    .click();
  await nav(page, "Moje dane");
  await expect(page.getByLabel(/Źródło nadrzędne: sleep/)).toHaveValue(/watch/);
  await page
    .getByLabel(/Źródło nadrzędne: sleep/)
    .selectOption({ label: "phone" });
  await page
    .getByRole("button", { name: "Zapisz wybór źródeł", exact: true })
    .click();
  expect((await backup(page)).observations.map((o) => o.value)).toEqual([420]);
});

test("ICS import, versioned cancellation and FIT persist only supported facts", async ({
  page,
}) => {
  await personal(page);
  const tomorrow = new Date(Date.now() + 86400000)
    .toISOString()
    .slice(0, 10)
    .replaceAll("-", "");
  const calendar = (event: string) =>
    `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:synthetic-ui-shift\r\n${event}\r\nEND:VEVENT\r\nEND:VCALENDAR`;
  await page
    .getByLabel("Wybierz plik", { exact: true })
    .setInputFiles(
      input(
        "shifts.ics",
        calendar(
          `SEQUENCE:1\r\nDTSTART:${tomorrow}T200000Z\r\nDTEND:${tomorrow}T230000Z\r\nSUMMARY:Private title\r\nDESCRIPTION:Private description`,
        ),
        "text/calendar",
      ),
    );
  await expect(page.getByRole("dialog")).toContainText("1 przedziałów");
  await confirm(page);
  let data = await backup(page);
  expect(data.busy).toHaveLength(1);
  expect(JSON.stringify(data)).not.toContain("Private description");
  expect(JSON.stringify(data)).not.toContain("Private title");
  await page
    .getByLabel("Wybierz plik", { exact: true })
    .setInputFiles(
      input(
        "shifts.ics",
        calendar("SEQUENCE:2\r\nSTATUS:CANCELLED"),
        "text/calendar",
      ),
    );
  await expect(page.getByRole("dialog")).toContainText("Anulowanie zdarzenia");
  await confirm(page);
  data = await backup(page);
  expect(data.busy).toHaveLength(0);
  expect(data.calendarImportState!.cancellations).toHaveLength(1);
  await page
    .getByLabel("Wybierz plik", { exact: true })
    .setInputFiles("fixtures/imports/synthetic-activity.fit");
  await expect(page.getByRole("dialog")).toContainText("activity_minutes");
  await confirm(page);
  data = await backup(page);
  expect(data.observations).toHaveLength(1);
  expect(data.observations[0]!.metric).toBe("activity_minutes");
  expect(JSON.stringify(data)).not.toMatch(
    /positionLat|positionLong|heartRate/,
  );
});

test("PDF page preview, explicit field confirmation, selective care export and complete source deletion", async ({
  page,
}) => {
  await personal(page);
  await page
    .getByLabel("Wybierz plik", { exact: true })
    .setInputFiles("fixtures/imports/synthetic-text.pdf");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByAltText(/Oryginalna strona 1/)).toBeVisible({
    timeout: 60000,
  });
  await dialog
    .getByRole("combobox", { name: "Status pola Czas spaceru", exact: true })
    .selectOption("confirmed");
  await confirm(page);
  let data = await backup(page);
  expect(
    data.documentFacts.filter((f) => f.status === "confirmed"),
  ).toHaveLength(1);
  expect(data.documentPages![0]!.imageAttachmentId).toBeTruthy();
  expect(data.sources[0]!.usageVerified).toBe(false);
  expect(data.sources[0]!.aiAllowed).toBe(false);
  await page
    .getByRole("button", { name: "Zasady użycia", exact: true })
    .click();
  await expect(
    page.getByLabel("Zasady pozwalają przekazać wybrane fragmenty", {
      exact: false,
    }),
  ).toBeDisabled();
  await page
    .getByLabel("Sprawdziłem zasady użycia tego źródła", { exact: true })
    .check();
  await page
    .getByLabel("Zasady pozwalają przekazać wybrane fragmenty", {
      exact: false,
    })
    .check();
  await page
    .getByRole("button", { name: "Zapisz zasady użycia", exact: true })
    .click();
  data = await backup(page);
  expect(data.sources[0]!.usageVerified).toBe(true);
  expect(data.sources[0]!.aiAllowed).toBe(true);
  expect(data.consents).toHaveLength(0);
  await page
    .getByRole("button", { name: "Sprawdź / popraw", exact: true })
    .nth(2)
    .click();
  await expect(
    page
      .getByRole("dialog")
      .getByAltText("Oryginalna strona 1", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Zamknij", exact: true }).click();
  await nav(page, "Przed wizytą");
  await expect(page.locator(".selection-list input")).toHaveCount(1);
  await page.locator(".selection-list input").check();
  await page
    .getByLabel("Cel rozmowy", { exact: true })
    .fill("Omówienie własnego planu");
  await page
    .getByRole("button", { name: "Podgląd karty konsultacji", exact: true })
    .click();
  const event = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Pobierz dostępny HTML", exact: true })
    .click();
  const report = await readFile((await (await event).path())!, "utf8");
  expect(report).toContain("Czas spaceru: 20 min");
  expect(report).not.toContain("Wartość testowa: 12,5");
  await page.getByRole("button", { name: "Zamknij", exact: true }).click();
  await nav(page, "Moje dane");
  await page
    .getByRole("button", {
      name: "Usuń źródło synthetic-text.pdf",
      exact: true,
    })
    .click();
  await page.getByRole("button", { name: "Usuń źródło", exact: true }).click();
  data = await backup(page);
  expect(data.documentFacts).toHaveLength(0);
  expect(data.attachments).toHaveLength(0);
  expect(JSON.stringify(data)).not.toContain("Czas spaceru: 20 min");
  expect(data.carePackets.every((p) => p.stale)).toBe(true);
});

test("local image OCR is cancellable and reviewed beside original, manual observations are editable", async ({
  page,
}) => {
  await personal(page);
  await page
    .getByLabel("Wybierz plik", { exact: true })
    .setInputFiles("fixtures/imports/synthetic-document.png");
  await page
    .getByRole("button", { name: "Przerwij import", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Import anulowany");
  expect((await backup(page)).documentFacts).toHaveLength(0);
  await page
    .getByLabel("Wybierz plik", { exact: true })
    .setInputFiles("fixtures/imports/synthetic-document.png");
  await expect(page.getByRole("dialog")).toContainText("Odczyt OCR", {
    timeout: 60000,
  });
  await expect(
    page.getByRole("dialog").getByAltText(/Oryginalna strona 1/),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toContainText("20 min");
  await confirm(page);
  await page.getByLabel("Wartość obserwacji", { exact: true }).fill("0");
  await page
    .getByLabel("Czas obserwacji", { exact: true })
    .fill("2026-10-03T12:00");
  await page
    .getByRole("button", { name: "Zapisz obserwację", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "Własna obserwacja zapisana",
  );
  await page
    .getByRole("button", { name: "Sprawdź / popraw pomiar", exact: true })
    .click();
  await page
    .getByLabel("Poprawiona wartość pomiaru", { exact: true })
    .fill("2,5");
  await page
    .getByRole("button", { name: "Zapisz korektę pomiaru", exact: true })
    .click();
  expect((await backup(page)).observations[0]!.value).toBe(2.5);
  await page
    .getByRole("button", { name: "Sprawdź / popraw pomiar", exact: true })
    .click();
  await page.getByRole("button", { name: "Usuń pomiar", exact: true }).click();
  expect((await backup(page)).observations).toHaveLength(0);
});
