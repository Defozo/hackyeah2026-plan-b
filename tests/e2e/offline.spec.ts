import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
test.use({ serviceWorkers: "allow" });
test("production offline reload, local OCR, save, report and no personal network transmission", async ({
  page,
  context,
}) => {
  test.skip(
    !process.env.E2E_BASE_URL?.includes("4181"),
    "Run against built preview with E2E_BASE_URL=http://localhost:4181",
  );
  test.setTimeout(240000);
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  await page.goto("/");
  await page
    .getByRole("button", { name: "Zobacz przykład", exact: true })
    .click();
  await expect(page.getByText("Gotowe offline", { exact: true })).toBeVisible({
    timeout: 150000,
  });
  const cached = await page.evaluate(async () => {
    const names = await caches.keys();
    const keys = (
      await Promise.all(
        names
          .filter((n) => n.startsWith("planb-shell-"))
          .map(async (n) =>
            (await (await caches.open(n)).keys()).map((r) => r.url),
          ),
      )
    ).flat();
    return keys;
  });
  expect(cached.some((u) => u.includes("/api/"))).toBe(false);
  expect(cached.some((u) => u.includes("pol.traineddata"))).toBe(true);
  await context.setOffline(true);
  await page.reload();
  await page
    .getByRole("button", { name: "Zobacz przykład", exact: true })
    .click();
  await expect(page.getByText("Bez sieci", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Dzień się zmienił", exact: true })
    .click();
  await expect(page.locator(".candidate")).toHaveCount(3);
  await page
    .getByRole("button", { name: "Odkładam decyzję", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Zmiana jest zapisana");
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Moje dane", exact: true })
    .click();
  await page
    .getByLabel("Wybierz plik", { exact: true })
    .setInputFiles("fixtures/imports/synthetic-document.png");
  await expect(page.getByRole("dialog")).toContainText(
    "Sprawdź import przed zapisem",
    { timeout: 60000 },
  );
  await expect(page.getByRole("dialog")).toContainText("20");
  await page
    .getByRole("button", { name: "Zatwierdź import", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Import zapisany");
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Przed wizytą", exact: true })
    .click();
  await page
    .getByLabel("Cel rozmowy", { exact: true })
    .fill("Raport bez sieci");
  await page.locator(".selection-list input").first().check();
  await page
    .getByRole("button", { name: "Podgląd karty konsultacji", exact: true })
    .click();
  const event = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Zatwierdź i pobierz PDF", exact: true })
    .click();
  const d = await event;
  expect((await readFile((await d.path())!)).subarray(0, 4).toString()).toBe(
    "%PDF",
  );
  expect(
    requests.filter(
      (u) => /^https?:/.test(u) && !u.startsWith("http://localhost:4181"),
    ),
  ).toEqual([]);
  await page.screenshot({
    path: "docs/evidence/offline-report.png",
    fullPage: true,
  });
});
