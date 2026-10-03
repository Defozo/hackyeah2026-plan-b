import { test, expect, type Page } from "@playwright/test";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
async function demo(page: Page) {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Zobacz przykład", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Dobry plan umie się zmienić." }),
  ).toBeVisible();
}
async function nav(page: Page, name: string) {
  await page
    .getByRole("navigation")
    .getByRole("button", { name, exact: true })
    .click();
}
test("repair, intentional choice, outcome, history, reload, selective HTML and PDF", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await demo(page);
  await page
    .getByRole("button", { name: "Dzień się zmienił", exact: true })
    .click();
  await expect(
    page.getByText("Potrzebujesz 50 minut, masz 20.", { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Co chcesz zachować?")
    .selectOption("specific-training");
  await expect(
    page
      .locator(".candidate")
      .filter({ has: page.getByRole("heading", { name: "Spacer przy domu" }) }),
  ).toHaveCount(0);
  await page.getByLabel("Co chcesz zachować?").selectOption("screen-break");
  const walk = page.locator(".candidate").filter({
    has: page.getByRole("heading", { name: "Spacer przy domu", exact: true }),
  });
  await walk
    .getByRole("button", { name: "Zobacz zmianę", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Zobacz zmianę przed zapisem" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Zatwierdź zmianę", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Zmiana jest zapisana");
  await expect(page.locator(".plan-title h2")).toHaveText("Spacer przy domu");
  await nav(page, "Historia");
  const row = page
    .locator("tbody tr")
    .filter({ hasText: "Spacer przy domu" })
    .last();
  await row.getByRole("button", { name: "Uzupełnij" }).click();
  await page
    .getByLabel("Twoja obserwacja (opcjonalnie)")
    .fill("Spacer był wygodny, zmieniłem trasę.");
  await page
    .getByRole("button", { name: "Zrobiłem inaczej", exact: true })
    .click();
  await expect(page.locator("tbody")).toContainText("Zrobiłem inaczej");
  await page.reload();
  await page
    .getByRole("button", { name: "Zobacz przykład", exact: true })
    .click();
  await nav(page, "Historia");
  await expect(page.locator("tbody")).toContainText("Zrobiłem inaczej");
  await nav(page, "Przed wizytą");
  await page
    .getByLabel("Cel rozmowy", { exact: true })
    .fill("Ruch przy pracy zmianowej");
  await page
    .getByLabel("Pytania (jedno w wierszu)")
    .fill("Jak ustalić godziny odpoczynku?");
  await page.locator(".selection-list input").nth(0).check();
  await page.locator(".selection-list input").nth(1).check();
  await page
    .getByRole("button", { name: "Podgląd karty konsultacji", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("Dane syntetyczne");
  await page
    .getByRole("dialog")
    .locator(".fact-row")
    .filter({ hasText: "sleep_duration" })
    .getByRole("button", { name: "Usuń z raportu", exact: true })
    .click();
  const htmlEvent = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Pobierz dostępny HTML", exact: true })
    .click();
  const html = await htmlEvent;
  const htmlText = await readFile((await html.path())!, "utf8");
  expect(htmlText).toContain("Ruch przy pracy zmianowej");
  expect(htmlText).not.toContain("sleep_duration");
  expect(htmlText).toContain("Chcę omówić organizację ruchu");
  expect(htmlText).toContain("Dane syntetyczne");
  const pdfEvent = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Zatwierdź i pobierz PDF", exact: true })
    .click();
  const pdf = await pdfEvent;
  const bytes = await readFile((await pdf.path())!);
  expect(bytes.subarray(0, 4).toString()).toBe("%PDF");
  expect(bytes.length).toBeGreaterThan(10000);
  await mkdir("docs/evidence", { recursive: true });
  await pdf.saveAs("docs/evidence/care-packet-synthetic.pdf");
  await page.getByRole("button", { name: "Zamknij", exact: true }).click();
  await page.screenshot({
    path: "docs/evidence/care-screen.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
test("personal vault, first activity, backup, wrong restore, successful restore and profile deletion", async ({
  page,
}) => {
  await page.goto("/");
  const phrase = "Testowa fraza osobista 2026";
  await page.getByLabel("Fraza sejfu", { exact: false }).fill(phrase);
  await page.getByRole("button", { name: "Utwórz sejf", exact: true }).click();
  await page
    .getByRole("button", { name: "Dodaj pierwszą aktywność", exact: true })
    .click();
  await page
    .getByLabel("Nazwa aktywności", { exact: true })
    .fill("Mój spokojny spacer");
  await page.getByLabel("Aktywność (min)", { exact: true }).fill("15");
  await page.getByLabel("Znam tę aktywność", { exact: false }).check();
  await page
    .getByRole("button", { name: "Zapisz aktywność", exact: true })
    .click();
  await expect(page.locator(".plan-title h2")).toHaveText(
    "Mój spokojny spacer",
  );
  await nav(page, "Moje dane");
  const backupEvent = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Pobierz kopię sejfu", exact: true })
    .click();
  const backup = await backupEvent;
  const location = (await backup.path())!;
  const encrypted = await readFile(location, "utf8");
  expect(encrypted).not.toContain("spokojny spacer");
  expect(encrypted).not.toContain(phrase);
  await page.getByText("Odtwórz kopię", { exact: true }).click();
  await page
    .getByLabel("Fraza kopii", { exact: true })
    .fill("Nieprawidłowa fraza");
  await page.getByLabel("Plik kopii", { exact: true }).setInputFiles(location);
  await expect(page.getByRole("status")).toContainText("Nieprawidłowa fraza");
  await page.getByLabel("Fraza kopii", { exact: true }).fill(phrase);
  await page.getByLabel("Plik kopii", { exact: true }).setInputFiles([]);
  await page.getByLabel("Plik kopii", { exact: true }).setInputFiles(location);
  await expect(page.getByRole("status")).toContainText(
    "Kopia została odtworzona",
  );
  await page
    .getByRole("button", { name: "Zablokuj sejf", exact: true })
    .first()
    .click();
  await page.getByLabel("Fraza sejfu", { exact: false }).fill(phrase);
  await page
    .getByRole("button", { name: "Odblokuj sejf", exact: true })
    .click();
  await expect(page.locator(".plan-title h2")).toHaveText(
    "Mój spokojny spacer",
  );
  await nav(page, "Moje dane");
  await page
    .getByRole("button", {
      name: "Usuń wszystkie dane tego profilu",
      exact: true,
    })
    .click();
  await page
    .getByRole("button", { name: "Potwierdzam usunięcie profilu", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Utwórz sejf", exact: true }),
  ).toBeVisible();
});
test("confirmed consultation limit changes next repair, unclear constraint never grants activity", async ({
  page,
}) => {
  await demo(page);
  await nav(page, "Przed wizytą");
  await page
    .getByRole("button", { name: "Ustalenia po konsultacji", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Treść ustalenia", exact: true })
    .fill("Syntetyczne ustalenie: znany trening maksymalnie 10 minut.");
  await page
    .getByLabel("Jakie ograniczenie zostało ustalone?")
    .selectOption("max_duration");
  await page.getByLabel("Czynność, której dotyczy").selectOption("training");
  await page.getByLabel("Maksymalny czas (min)").fill("10");
  await page
    .getByLabel("Potwierdzam, że wybrane ograniczenie", { exact: false })
    .check();
  await page
    .getByRole("button", { name: "Zapisz ustalenie", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Ustalenie zapisane");
  await nav(page, "Dzisiaj");
  await page
    .getByRole("button", { name: "Dzień się zmienił", exact: true })
    .click();
  await expect(
    page.locator(".candidate").getByRole("heading", { name: /trening/i }),
  ).toHaveCount(0);
  await expect(page.locator(".candidate").first()).toContainText(
    "Spacer przy domu",
  );
  await page.getByRole("button", { name: "Zamknij", exact: true }).click();
  await nav(page, "Przed wizytą");
  await page
    .getByRole("button", { name: "Ustalenia po konsultacji", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Treść ustalenia", exact: true })
    .fill("Warunek tętna wymaga omówienia.");
  await page
    .getByLabel("Jakie ograniczenie zostało ustalone?")
    .selectOption("unmapped");
  await page.getByLabel("Czynność, której dotyczy").selectOption("");
  await page
    .getByRole("button", { name: "Zapisz ustalenie", exact: true })
    .click();
  await nav(page, "Dzisiaj");
  await page
    .getByRole("button", { name: "Dzień się zmienił", exact: true })
    .click();
  await expect(
    page.getByText(/Nie mam potwierdzonego wariantu przy tych danych/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Wybieram odpoczynek" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Zamknij", exact: true }).click();
  await nav(page, "Przed wizytą");
  await page
    .locator(".fact-row")
    .filter({ hasText: "Warunek tętna wymaga omówienia." })
    .getByRole("button", { name: "Przygotuj doprecyzowanie", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Treść ustalenia", exact: true })
    .fill("Po wyjaśnieniu uzgodniono własny spacer przy domu.");
  await page
    .getByRole("combobox", {
      name: "Jakie ograniczenie zostało ustalone?",
      exact: true,
    })
    .selectOption("variant");
  await page
    .getByRole("combobox", {
      name: "Własny wariant uzgodniony ze specjalistą",
      exact: true,
    })
    .selectOption("walk-15");
  await page
    .getByRole("checkbox", {
      name: "Potwierdzam, że wybrane ograniczenie wiernie odwzorowuje ustalenie.",
      exact: true,
    })
    .check();
  await page
    .getByRole("button", { name: "Zapisz ustalenie", exact: true })
    .click();
  await expect(
    page.getByText("Warunek tętna wymaga omówienia.", { exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await page
    .getByRole("button", { name: "Zobacz przykład", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Dzień się zmienił", exact: true })
    .click();
  await expect(
    page
      .locator(".candidate")
      .getByRole("heading", {
        name: "Spacer przy domu",
        exact: true,
      })
      .first(),
  ).toBeVisible();
  // A separate confirmed duration limit must survive clarification of the other rule.
  await expect(
    page.locator(".candidate").getByRole("heading", { name: /trening/i }),
  ).toHaveCount(0);
});
test("network failure, no results and NFZ pagination remain distinct in the interface", async ({
  page,
}) => {
  await demo(page);
  await nav(page, "Przed wizytą");
  await page
    .getByLabel("Świadczenie", { exact: true })
    .fill("PORADNIA REHABILITACYJNA");
  await page
    .getByRole("combobox", { name: "Kategoria przypadku", exact: true })
    .selectOption("1");
  await page.route("**/api/care/queues?**", (route) =>
    route.fulfill({ status: 502, contentType: "application/json", body: "{}" }),
  );
  await page
    .getByRole("button", { name: "Szukaj placówek", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Nie udało się pobrać placówek",
  );
  await expect(page.getByLabel("Świadczenie", { exact: true })).toHaveValue(
    "PORADNIA REHABILITACYJNA",
  );
  await page.unroute("**/api/care/queues?**");
  await page.route("**/api/care/queues?**", (route) =>
    route.fulfill({
      json: {
        items: [],
        page: 1,
        hasNext: false,
        total: 0,
        source: "NFZ: atrapa testu błędów",
        fetchedAt: new Date().toISOString(),
        cache: "live",
      },
    }),
  );
  await page
    .getByRole("button", { name: "Szukaj placówek", exact: true })
    .click();
  await expect(
    page.getByText("Brak wyników dla podanych filtrów.", { exact: true }),
  ).toBeVisible();
});
test("desktop keyboard and automated accessibility", async ({ page }) => {
  await demo(page);
  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).toBeVisible();
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(result.violations).toEqual([]);
  await page.getByRole("button", { name: "Dzień się zmienił" }).click();
  await expect(page.locator(".candidate")).toHaveCount(3);
  const modal = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(modal.violations).toEqual([]);
});
