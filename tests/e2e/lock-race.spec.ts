import { test, expect } from "@playwright/test";

test("locking during an encrypted write never restores decrypted UI", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByLabel("Fraza sejfu", { exact: false })
    .fill("Test blokady podczas zapisu 2026");
  await page.getByRole("button", { name: "Utwórz sejf", exact: true }).click();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Moje dane", exact: true })
    .click();
  await page.evaluate(() => {
    const original = crypto.subtle.encrypt.bind(crypto.subtle);
    crypto.subtle.encrypt = async (algorithm, key, data) => {
      const encrypted = await original(algorithm, key, data);
      await new Promise<void>((resolve) => {
        (window as unknown as { resumePlanbSave: () => void }).resumePlanbSave =
          resolve;
      });
      return encrypted;
    };
  });
  await page
    .getByLabel("Przypomnienie o rezultacie przy otwieraniu aplikacji", {
      exact: true,
    })
    .click();
  await page.waitForFunction(
    () =>
      typeof (window as unknown as { resumePlanbSave?: () => void })
        .resumePlanbSave === "function",
  );
  await page
    .getByRole("button", { name: "Zablokuj sejf", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("button", { name: "Odblokuj sejf", exact: true }),
  ).toBeVisible();
  await page.evaluate(() =>
    (window as unknown as { resumePlanbSave: () => void }).resumePlanbSave(),
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          new Promise<number>((resolve, reject) => {
            const request = indexedDB.open("planb-personal");
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const db = request.result;
              const get = db
                .transaction("records")
                .objectStore("records")
                .get("vault");
              get.onsuccess = () => {
                resolve(get.result.envelope.generation);
                db.close();
              };
              get.onerror = () => reject(get.error);
            };
          }),
      ),
    )
    .toBe(1);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(page.getByRole("navigation")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Odblokuj sejf", exact: true }),
  ).toBeVisible();
});
