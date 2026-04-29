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
    // ── Anti-bot detection hardening ────────────────────────────────────────────
    //
    // sec-ch-ua client hints must be version-coherent with the User-Agent string.
    // Headless Chromium omits or mismatches these, which is a reliable bot signal.
    extraHTTPHeaders: {
      "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Linux"',
    },
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    viewport: { width: 1366, height: 768 },
    // ── Residential proxy ────────────────────────────────────────────────────────
    // Ashby integrates Socure fraud detection which classifies datacenter IPs
    // (Railway, AWS, GCP, etc.) as high-risk and blocks submission server-side —
    // no client-side patch can fix this.  A residential proxy makes the session
    // appear to originate from a normal ISP connection.
    //
    // Set JOBPAL_PROXY_URL in Railway environment variables:
    //   http://USERNAME:PASSWORD@proxy.provider.com:PORT
    //
    // Use sticky-session mode (most providers: append ?session=<id> to the URL)
    // so the IP does not rotate mid-run.  If the variable is unset the proxy is
    // disabled and Playwright connects directly (fine for local dev / Greenhouse).
    ...(process.env.JOBPAL_PROXY_URL
      ? { proxy: { server: process.env.JOBPAL_PROXY_URL } }
      : {}),
    launchOptions: {
      // ── Retail Chrome binary ─────────────────────────────────────────────────
      // Playwright's bundled Chromium has a JA3/JA4 TLS fingerprint that does
      // not match any real Chrome release.  Pointing to an installed Chrome binary
      // fixes this at the network layer for free.  Falls back to bundled Chromium
      // if CHROME_EXECUTABLE_PATH is not set (local dev without Chrome installed).
      executablePath: process.env.CHROME_EXECUTABLE_PATH || undefined,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-infobars",
        "--disable-extensions-except=",
        "--disable-extensions",
      ],
    },
  },
});
