import type { Page } from "@playwright/test";
import type { BlockerKind } from "../types";

export type BlockerResult = { blocked: true; kind: BlockerKind; detail: string } | { blocked: false };

const CAPTCHA_PATTERNS = [/recaptcha/i, /hcaptcha/i, /captcha/i, /turnstile/i];
const LOGIN_PATH_HINTS = [/\/sign[_-]?in/i, /\/login/i, /\/session/i, /\/auth\//i];

function pageTextBlob(page: Page): Promise<string> {
  return page.evaluate(() => document.body?.innerText?.slice(0, 80_000) ?? "");
}

async function hasCaptchaFrame(page: Page): Promise<boolean> {
  for (const frame of page.frames()) {
    const u = frame.url();
    if (CAPTCHA_PATTERNS.some((p) => p.test(u))) return true;
  }
  return false;
}

async function hasCaptchaDom(page: Page): Promise<boolean> {
  const hit = await page.evaluate(() => {
    const sel = [
      "iframe[src*='recaptcha']",
      "iframe[src*='hcaptcha']",
      "iframe[title*='reCAPTCHA']",
      "[data-sitekey]",
      ".g-recaptcha",
      "#cf-turnstile",
    ].join(",");
    return !!document.querySelector(sel);
  });
  return hit;
}

/**
 * Heuristic detection for flows we should not drive automatically.
 */
export async function detectBlockers(page: Page): Promise<BlockerResult> {
  const url = page.url();

  if ((await hasCaptchaFrame(page)) || (await hasCaptchaDom(page))) {
    return {
      blocked: true,
      kind: "captcha",
      detail: "Captcha or bot challenge present on the page or in a frame.",
    };
  }

  for (const hint of LOGIN_PATH_HINTS) {
    if (hint.test(url)) {
      return {
        blocked: true,
        kind: "login",
        detail: `URL suggests an auth wall: ${url}`,
      };
    }
  }

  const text = (await pageTextBlob(page)).toLowerCase();
  const loginHeavy =
    /\bpassword\b/.test(text) && (/\bsign in\b/.test(text) || /\blog in\b/.test(text));

  if (loginHeavy) {
    const applySignals =
      /\bapply\b/.test(text) ||
      /\bapplication\b/.test(text) ||
      /\bresume\b/.test(text) ||
      /\bfirst name\b/.test(text) ||
      /\bjob\b/.test(text);
    if (!applySignals) {
      return {
        blocked: true,
        kind: "login",
        detail: "Page content looks like a sign-in gate without an obvious application form.",
      };
    }
  }

  return { blocked: false };
}
