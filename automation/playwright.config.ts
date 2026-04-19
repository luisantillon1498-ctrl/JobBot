import { defineConfig, devices } from "@playwright/test";

/**
 * Standalone config for job-board automation (relative paths from this file).
 * Run: npx playwright test -c automation/playwright.config.ts
 *
 * headless: false — Playwright launches a headed browser on the Xvfb virtual
 * display (:99). x11vnc + websockify + noVNC then let users view and interact
 * with that browser via a WebSocket iframe — no third-party account required.
 *
 * timeout: 1_800_000 — allows up to 30 minutes for a user to solve a CAPTCHA
 * challenge in the live browser before the run times out.
 */
export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: "list",
  timeout: 1_800_000,
  use: {
    ...devices["Desktop Chrome"],
    headless: false,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    locale: "en-US",
  },
});
