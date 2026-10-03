import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 120000,
  expect: { timeout: 15000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [
    ["list"],
    ["html", { open: "never" }],
    ["json", { outputFile: "docs/evidence/e2e-results.json" }],
  ],
  use: {
    actionTimeout: 20000,
    navigationTimeout: 30000,
    // Functional contexts avoid downloading the 60 MB OCR cache for every test.
    // The dedicated offline scenario explicitly enables and verifies the real worker.
    serviceWorkers: "block",
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:5181",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    acceptDownloads: true,
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    {
      name: "mobile",
      use: { ...devices["Pixel 7"] },
      testMatch: /mobile\.spec\.ts/,
    },
  ],
  webServer: process.env.E2E_NO_SERVER
    ? undefined
    : {
        command: "pnpm dev",
        url: "http://localhost:5181",
        reuseExistingServer: true,
        timeout: 120000,
      },
});
