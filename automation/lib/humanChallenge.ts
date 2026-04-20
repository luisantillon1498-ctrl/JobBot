import type { Page } from "@playwright/test";

/**
 * Detect bot checks / human verification using the main document only (no cross-frame navigation).
 * Does not solve or bypass challenges — only flags that automation should pause for human-in-the-loop.
 *
 * Distinguishes between:
 *  - BLOCKING CAPTCHAs: the CAPTCHA is the primary page content (e.g. Cloudflare Turnstile
 *    interstitial, full-page reCAPTCHA). Automation cannot proceed at all.
 *  - EMBEDDED CAPTCHAs: a reCAPTCHA widget is part of an application form alongside other
 *    inputs (e.g. Greenhouse embeds a reCAPTCHA at the bottom of the apply form). Automation
 *    should fill all other fields first; the CAPTCHA is only needed at submit time.
 *
 * Only BLOCKING CAPTCHAs cause a pause. Embedded ones are ignored here — the filler proceeds
 * normally and the user solves the CAPTCHA widget when they review the filled form.
 */
export async function detectHumanChallenge(page: Page): Promise<{ present: boolean; detail: string }> {
  const hit = await page.evaluate(() => {
    const doc = document;

    // ── Definite blocking indicators ─────────────────────────────────────────
    // These selectors only appear on dedicated CAPTCHA challenge pages, not in
    // embedded form widgets.
    const blockingSelectors = [
      "#cf-turnstile",                        // Cloudflare Turnstile interstitial
      "iframe[src*='hcaptcha']",              // hCaptcha (always a blocking overlay)
      ".h-captcha",
    ];
    for (const sel of blockingSelectors) {
      if (doc.querySelector(sel)) return { present: true, reason: "dom_widget_blocking" };
    }

    // ── Possibly-embedded reCAPTCHA widgets ──────────────────────────────────
    // [data-sitekey], .g-recaptcha, and reCAPTCHA iframes appear both on blocking
    // CAPTCHA pages AND inside Greenhouse/Workday/Ashby application forms.
    // Only treat them as blocking if the page has few other interactive form fields
    // (meaning the CAPTCHA IS the page, not just part of it).
    const recaptchaPresent = Boolean(
      doc.querySelector("[data-sitekey], .g-recaptcha, iframe[src*='recaptcha'], iframe[title*='reCAPTCHA']"),
    );
    if (recaptchaPresent) {
      // Count visible text inputs, selects, textareas, and file inputs on the page.
      // An application form will have many; a pure CAPTCHA page will have zero.
      const formInputs = doc.querySelectorAll(
        "input:not([type='hidden']):not([type='submit']):not([type='button']):not([type='checkbox']):not([type='radio']), select, textarea, input[type='file']",
      );
      const visibleInputCount = Array.from(formInputs).filter((el) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }).length;

      // If there are 3+ visible form inputs alongside the reCAPTCHA, it's embedded —
      // don't block. The filler will handle the other fields; user solves CAPTCHA at review.
      if (visibleInputCount >= 3) {
        return { present: false, reason: "recaptcha_embedded_in_form" };
      }

      return { present: true, reason: "dom_widget_recaptcha" };
    }

    // ── Text-based detection ──────────────────────────────────────────────────
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
