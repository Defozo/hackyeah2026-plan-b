import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
test("mobile navigation, decisions, no horizontal overflow and reduced motion", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Zobacz przykład", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Dobry plan umie się zmienić." }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  await page
    .getByRole("button", { name: "Dzień się zmienił", exact: true })
    .click();
  await expect(page.locator(".candidate")).toHaveCount(3);
  await page.getByRole("button", { name: "Wybieram odpoczynek" }).click();
  await expect(page.getByRole("status")).toContainText("Zmiana jest zapisana");
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Historia", exact: true })
    .click();
  await expect(page.locator("tbody")).toContainText("Odpoczynek");
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Mój tydzień", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Najbliższe 7 dni" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(result.violations).toEqual([]);
  await page.screenshot({
    path: `docs/evidence/mobile-${test.info().project.name}.png`,
    fullPage: true,
  });
});
