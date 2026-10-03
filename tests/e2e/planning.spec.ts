import { test, expect, type Page } from "@playwright/test";
import { DateTime } from "luxon";
test.use({ actionTimeout: 20000 });

async function nav(page: Page, name: string) {
  await page
    .getByRole("navigation")
    .getByRole("button", { name, exact: true })
    .click();
}
async function personal(page: Page) {
  await page.goto("/");
  await page
    .getByLabel("Fraza sejfu", { exact: false })
    .fill("Własny plan testowy 2026");
  await page.getByRole("button", { name: "Utwórz sejf", exact: true }).click();
  await page
    .getByRole("button", { name: "Dodaj pierwszą aktywność", exact: true })
    .click();
  await page
    .getByLabel("Początek", { exact: true })
    .fill(
      DateTime.now()
        .setZone("Europe/Warsaw")
        .plus({ hours: 2 })
        .startOf("hour")
        .toFormat("yyyy-MM-dd'T'HH:mm"),
    );
}
async function saveActivity(page: Page) {
  await page.getByLabel("Znam tę aktywność", { exact: false }).check();
  await page
    .getByRole("button", { name: "Zapisz aktywność", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

test("unknown travel remains a conflict until the own variant is edited and repaired", async ({
  page,
}) => {
  await personal(page);
  await page
    .getByLabel("Nazwa aktywności", { exact: true })
    .fill("Mój spacer po pracy");
  await page.getByLabel("Aktywność (min)", { exact: true }).fill("15");
  await page.getByLabel("Dojazd łącznie (min)", { exact: false }).fill("");
  await page
    .getByLabel("Własny cel (opcjonalnie)", { exact: false })
    .fill("Odetchnąć po pracy");
  await saveActivity(page);
  await expect(
    page.getByText("Pełny czas nieznany", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Dzień się zmienił", exact: true })
    .click();
  await expect(
    page.getByText(/Nie mam potwierdzonego wariantu przy tych danych/),
  ).toBeVisible();
  await expect(page.locator(".candidate")).toHaveCount(0);
  await page.getByRole("button", { name: "Zamknij", exact: true }).click();
  await nav(page, "Mój tydzień");
  await expect(
    page.getByText("Odetchnąć po pracy", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: "Edytuj wariant Mój spacer po pracy",
      exact: true,
    })
    .click();
  await page.getByLabel("Dojazd łącznie (min)", { exact: false }).fill("5");
  await page
    .getByLabel("Towarzystwo (opcjonalnie)", { exact: true })
    .fill("Sam");
  await page
    .getByLabel("Preferowane pory (opcjonalnie)", { exact: false })
    .fill("07:30, 18:00");
  await page.getByLabel("Znam tę aktywność", { exact: false }).check();
  await page
    .getByRole("button", { name: "Zapisz wariant", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: "Edytuj wariant Mój spacer po pracy",
      exact: true,
    }),
  ).toHaveCount(1);
  await nav(page, "Dzisiaj");
  await page
    .getByRole("button", { name: "Dzień się zmienił", exact: true })
    .click();
  await expect(page.locator(".candidate")).toHaveCount(1);
  await expect(page.locator(".candidate")).toContainText("20 min łącznie");
  await expect(page.locator(".candidate")).toContainText("dojazd: 5 min");
  await page
    .getByRole("button", { name: "Zobacz zmianę", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Zatwierdź zmianę", exact: true })
    .click();
  await expect(page.locator(".plan-title h2")).toHaveText(
    "Mój spacer po pracy",
  );
  await expect(page.getByText("20 min łącznie", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Zrobiłem", exact: true }),
  ).toHaveCount(0);
});

test("rejecting a preview keeps the original intention and the reduced available window after reload", async ({
  page,
}) => {
  await personal(page);
  await page
    .getByLabel("Nazwa aktywności", { exact: true })
    .fill("Pełny własny trening");
  await page.getByLabel("Aktywność (min)", { exact: true }).fill("50");
  await saveActivity(page);
  await nav(page, "Mój tydzień");
  await page
    .getByRole("button", { name: "Dodaj aktywność lub wariant", exact: true })
    .click();
  await page
    .getByLabel("Nazwa aktywności", { exact: true })
    .fill("Znany krótki wariant");
  await page.getByLabel("Aktywność (min)", { exact: true }).fill("15");
  await page
    .getByLabel("Zaplanuj ten wariant w dostępnym oknie", { exact: true })
    .uncheck();
  await saveActivity(page);
  await nav(page, "Dzisiaj");
  await page
    .getByRole("button", { name: "Dzień się zmienił", exact: true })
    .click();
  await expect(
    page.getByText("Potrzebujesz 50 minut, masz 20.", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Zobacz zmianę", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Odrzuć podgląd", exact: true })
    .click();
  await expect(page.locator(".plan-title h2")).toHaveText(
    "Pełny własny trening",
  );
  await expect(
    page.getByText("Potrzebujesz 50 minut, masz 20.", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await page
    .getByLabel("Fraza sejfu", { exact: false })
    .fill("Własny plan testowy 2026");
  await page
    .getByRole("button", { name: "Odblokuj sejf", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Dzień się zmienił", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Co się zmieniło?", exact: true })
    .selectOption("Samopoczucie");
  await expect(
    page
      .getByRole("dialog")
      .getByText("Potrzebujesz 50 minut, masz 20.", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".candidate")).toHaveCount(1);
});

test("resource windows constrain repair and calendar has an accessible list alternative", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Zobacz przykład", exact: true })
    .click();
  await nav(page, "Mój tydzień");
  await page.getByRole("button", { name: "Kalendarz", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Kalendarz siedmiu dni" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Lista", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Lista", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page
    .getByRole("button", {
      name: "Edytuj dostępność Moja sala treningowa",
      exact: true,
    })
    .click();
  await page
    .getByLabel("Dostępne tylko w określonych godzinach", { exact: true })
    .check();
  const tomorrow = DateTime.now()
    .setZone("Europe/Warsaw")
    .plus({ days: 1 })
    .set({ hour: 17, minute: 0, second: 0 });
  await page
    .getByLabel("Zasób dostępny od", { exact: true })
    .fill(tomorrow.toFormat("yyyy-MM-dd'T'HH:mm"));
  await page
    .getByLabel("Zasób dostępny do", { exact: true })
    .fill(tomorrow.plus({ hours: 1 }).toFormat("yyyy-MM-dd'T'HH:mm"));
  await page
    .getByRole("button", { name: "Dodaj okno zasobu", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Zapisz dostępność", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await nav(page, "Dzisiaj");
  await page
    .getByRole("button", { name: "Dzień się zmienił", exact: true })
    .click();
  const gym = page.locator(".candidate").filter({
    has: page.getByRole("heading", {
      name: "Mój trening na sali",
      exact: true,
    }),
  });
  await expect(gym).toHaveCount(1);
  await expect(gym).toContainText("17:00");
  await page
    .getByRole("combobox", { name: "Co się zmieniło?", exact: true })
    .selectOption("Brak sprzętu");
  await page
    .getByRole("combobox", { name: "Moja sala treningowa", exact: true })
    .selectOption("false");
  await expect(gym).toHaveCount(0);
  await page
    .getByRole("button", { name: "Odkładam decyzję", exact: true })
    .click();
  await nav(page, "Mój tydzień");
  await expect(
    page.locator(".source-row").filter({ hasText: "Moja sala treningowa" }),
  ).toContainText("Niedostępne");
});

test("outcome reminders are optional and history keeps the original intention separate from the choice", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date("2026-10-03T12:00:00Z"));
  await page.goto("/");
  await page
    .getByRole("button", { name: "Zobacz przykład", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Jak poszło ostatnim razem?",
      exact: true,
    }),
  ).toHaveCount(0);
  await nav(page, "Historia");
  await expect(
    page.getByRole("columnheader", { name: "Pierwotny zamiar", exact: true }),
  ).toBeVisible();
  const pending = page
    .locator("tbody tr")
    .filter({ hasText: "Brak odpowiedzi" });
  await expect(pending).toHaveCount(1);
  await expect(pending.getByRole("cell").nth(1)).toContainText("Mój trening");
  await expect(pending.getByRole("cell").nth(2)).toContainText(
    "Spacer przy domu",
  );
  await pending.getByRole("button", { name: "Uzupełnij", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Zrobiłem", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Zamknij", exact: true }).click();
  await nav(page, "Moje dane");
  const reminder = page.getByLabel(
    "Przypomnienie o rezultacie przy otwieraniu aplikacji",
    { exact: true },
  );
  await expect(reminder).not.toBeChecked();
  await reminder.click();
  // The controlled checkbox changes after the encrypted write commits.
  await expect(reminder).toBeChecked();
  await nav(page, "Dzisiaj");
  await expect(
    page.getByRole("heading", {
      name: "Jak poszło ostatnim razem?",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Zrobiłem", exact: true }),
  ).toHaveCount(1);
  await page.reload();
  await page
    .getByRole("button", { name: "Zobacz przykład", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Jak poszło ostatnim razem?",
      exact: true,
    }),
  ).toBeVisible();
  await nav(page, "Moje dane");
  await expect(reminder).toBeChecked();
  await reminder.click();
  await expect(reminder).not.toBeChecked();
  await nav(page, "Dzisiaj");
  await expect(
    page.getByRole("heading", {
      name: "Jak poszło ostatnim razem?",
      exact: true,
    }),
  ).toHaveCount(0);
  await nav(page, "Historia");
  await pending.getByRole("button", { name: "Uzupełnij", exact: true }).click();
  await page.getByRole("button", { name: "Zrobiłem", exact: true }).click();
  await expect(
    page.locator("tbody tr").filter({ hasText: "Brak odpowiedzi" }),
  ).toHaveCount(0);
});

test("history source details respect the selected period and refresh after a correction", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date("2026-10-03T12:00:00Z"));
  await page.goto("/");
  await page
    .getByRole("button", { name: "Zobacz przykład", exact: true })
    .click();
  await nav(page, "Moje dane");
  await page.getByLabel("Wybierz plik", { exact: true }).setInputFiles({
    name: "history-period.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      [
        "source,external_id,metric,start,end,value,unit",
        "audit-watch,recent,steps,2026-10-01T12:00:00Z,2026-10-01T12:01:00Z,100,steps",
        "audit-watch,older,steps,2026-09-13T12:00:00Z,2026-09-13T12:01:00Z,200,steps",
        "audit-watch,outside,steps,2026-08-29T12:00:00Z,2026-08-29T12:01:00Z,300,steps",
      ].join("\n"),
    ),
  });
  await page
    .getByRole("button", { name: "Pokaż podgląd CSV", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Zatwierdź import", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await nav(page, "Historia");
  const coverage = page
    .locator(".coverage")
    .filter({ hasText: "history-period.csv" });
  await expect(coverage).toContainText("1 z 7 dni · 1 zapisów");
  await coverage.getByText("Pokaż źródło i zapisy", { exact: true }).click();
  await expect(coverage.locator("details p")).toHaveCount(1);
  await expect(coverage.locator("details")).toContainText("100 steps");
  await expect(coverage.locator("details")).not.toContainText("200 steps");
  await page.getByRole("button", { name: "28 dni", exact: true }).click();
  await expect(coverage).toContainText("2 z 28 dni · 2 zapisów");
  await expect(coverage.locator("details p")).toHaveCount(2);
  await expect(coverage.locator("details")).toContainText("200 steps");
  await expect(coverage.locator("details")).not.toContainText("300 steps");
  await nav(page, "Moje dane");
  await page
    .locator(".fact-row")
    .filter({ hasText: "steps: 100 steps" })
    .getByRole("button", { name: "Sprawdź / popraw pomiar", exact: true })
    .click();
  await page
    .getByLabel("Poprawiona wartość pomiaru", { exact: true })
    .fill("110");
  await page
    .getByRole("button", { name: "Zapisz korektę pomiaru", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await nav(page, "Historia");
  await coverage.getByText("Pokaż źródło i zapisy", { exact: true }).click();
  await expect(coverage.locator("details p")).toHaveCount(1);
  await expect(coverage.locator("details")).toContainText("110 steps");
  await expect(coverage.locator("details")).not.toContainText("100 steps");
});
