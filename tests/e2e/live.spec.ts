import { test, expect } from "@playwright/test";
test("live NFZ response and pagination, synthetic Groq and reviewed Polish transcription", async ({
  page,
}) => {
  test.skip(
    process.env.E2E_LIVE_SERVICES !== "true",
    "Explicit synthetic live integration run",
  );
  test.setTimeout(180000);
  await page.goto("/");
  await page
    .getByRole("button", { name: "Zobacz przykład", exact: true })
    .click();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Przed wizytą", exact: true })
    .click();
  await page
    .getByLabel("Świadczenie", { exact: true })
    .fill("PORADNIA REHABILITACYJNA");
  await page
    .getByRole("combobox", { name: "Kategoria przypadku", exact: true })
    .selectOption("1");
  await page
    .getByRole("button", { name: "Szukaj placówek", exact: true })
    .click();
  await expect(page.locator(".provider").first()).toBeVisible({
    timeout: 30000,
  });
  await expect(
    page
      .getByText("Prognozowany czas udzielenia świadczenia:", { exact: false })
      .first(),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Następna strona", exact: true })
    .click();
  await expect(page.getByText(/Strona 2 · wyników/)).toBeVisible();
  await page
    .getByRole("button", { name: "Pomoc w uporządkowaniu", exact: true })
    .click();
  await page
    .getByLabel("Zgadzam się przekazać wybrany zakres", { exact: false })
    .check();
  await page
    .getByRole("button", { name: "Zatwierdź zakres i wyślij", exact: true })
    .click();
  await expect(page.getByRole("dialog").getByRole("status")).toContainText(
    /Groq|szablon/,
    { timeout: 30000 },
  );
  if (await page.getByRole("dialog").count())
    await page.getByRole("button", { name: "Zamknij", exact: true }).click();
  await page
    .getByRole("button", { name: "Dyktuj notatkę", exact: true })
    .click();
  await expect(page.locator("audio")).toHaveAttribute("src", /synthetic-audio/);
  await page.getByLabel("Odsłuchałem nagranie.", { exact: false }).check();
  await page
    .getByRole("button", { name: "Wyślij do transkrypcji", exact: true })
    .click();
  await expect(page.getByLabel("Popraw treść przed użyciem")).not.toHaveValue(
    "",
    { timeout: 30000 },
  );
  const transcript = await page
    .getByLabel("Popraw treść przed użyciem")
    .inputValue();
  expect(transcript.toLowerCase()).toContain("nie");
  expect(transcript).toMatch(/20|dwadzieścia/);
  await page
    .getByLabel("Popraw treść przed użyciem")
    .fill("Nie biegałem. Spacer trwał 20 minut. Dane syntetyczne.");
  await page
    .getByRole("button", { name: "Użyj sprawdzonego tekstu", exact: true })
    .click();
  expect(
    await page.getByLabel("Pytania (jedno w wierszu)").inputValue(),
  ).toContain("Spacer trwał 20 minut");
  await page.screenshot({ path: "docs/evidence/live-nfz.png", fullPage: true });
});
