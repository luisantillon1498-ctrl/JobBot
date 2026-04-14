import { defineConfig, devices } from "@playwright/test";

/**
 * Standalone config for job-board automation (avoids root lovable-agent-playwright-config).
 * Run: npx playwright test -c automation/playwright.config.ts
 */
export default defineConfig({
  testDir: ".",
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
