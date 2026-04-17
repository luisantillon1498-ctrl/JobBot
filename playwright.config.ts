import { defineConfig, devices } from "@playwright/test";

/**
 * Root Playwright config. Automation specs live under `automation/`.
 * Prefer: `npx playwright test -c automation/playwright.config.ts`
 */
export default defineConfig({
  testDir: "automation",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: "list",
  timeout: 120_000,
  use: {
    ...devices["Desktop Chrome"],
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    locale: "en-US",
  },
});
