import type { Page } from "@playwright/test";

/**
 * Detect bot checks / human verification using the main document only (no cross-frame navigation).
 * Does not solve or bypass challenges — only flags that automation should pause for human-in-the-loop.
 */
export async function detectHumanChallenge(page: Page): Promise<{ present: boolean; detail: string }> {
  const hit = await page.evaluate(() => {
    const doc = document;
    const sel = [
      "iframe[src*='recaptcha']",
      "iframe[src*='hcaptcha']",
      "iframe[title*='reCAPTCHA']",
      "[data-sitekey]",
      ".g-recaptcha",
      "#cf-turnstile",
    ].join(",");
    if (doc.querySelector(sel)) return { present: true, reason: "dom_widget" };

    const t = (doc.body?.innerText ?? "").toLowerCase();
    const phrases = [
      "i'm not a robot",
      "i am not a robot",
      "verify you are human",
      "verify you're human",
      "human verification",
      "prove you're human",
      "prove you are human",
      "bot check",
      "security check",
      "before you continue",
      "are you a robot",
    ];
    for (const p of phrases) {
      if (t.includes(p)) return { present: true, reason: `text:${p}` };
    }
    return { present: false, reason: "" };
  });

  if (!hit.present) return { present: false, detail: "" };
  return {
    present: true,
    detail: `Human verification or bot challenge detected (${hit.reason}).`,
  };
}
