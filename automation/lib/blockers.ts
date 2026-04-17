import type { Page } from "@playwright/test";
import type { BlockerKind } from "../types";

export type BlockerResult = { blocked: true; kind: BlockerKind; detail: string } | { blocked: false };

const LOGIN_PATH_HINTS = [/\/sign[_-]?in/i, /\/login/i, /\/session/i, /\/auth\//i];
const TWO_FACTOR_PATTERNS = [/two[-\s]?factor/i, /\b2fa\b/i, /\bone[-\s]?time code\b/i, /\bverification code\b/i];

// Known ATS domains where multi-step flows are expected and should NOT be blocked.
const KNOWN_ATS_HOSTS = [
  "greenhouse.io",
  "boards.greenhouse.io",
  "ashbyhq.com",
  "jobs.ashbyhq.com",
  "myworkdayjobs.com",
  "workday.com",
  "lever.co",
  "jobs.lever.co",
];

// Only flag as multi-step if we see flows that are genuinely non-ATS gating patterns.
// Deliberately excludes "progress", "next step", "continue application" — all normal in ATS forms.
const MULTI_STEP_PATTERNS = [
  /\bcreate an account to apply\b/i,
  /\bsign up to continue\b/i,
  /\byou must (log in|sign in|register) (before|to) appl/i,
];

function pageTextBlob(page: Page): Promise<string> {
  return page.evaluate(() => document.body?.innerText?.slice(0, 80_000) ?? "");
}

/**
 * Heuristic detection for flows we should not drive automatically.
 * Captcha / human verification is handled separately via human-in-the-loop (see `detectHumanChallenge`).
 */
function isKnownAtsHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return KNOWN_ATS_HOSTS.some((ats) => host === ats || host.endsWith(`.${ats}`));
  } catch {
    return false;
  }
}

export async function detectBlockers(page: Page): Promise<BlockerResult> {
  const url = page.url();
  const text = (await pageTextBlob(page)).toLowerCase();
  const knownAts = isKnownAtsHost(url);

  // Skip login-path check on known ATS hosts — their auth paths are part of the apply flow.
  if (!knownAts) {
    for (const hint of LOGIN_PATH_HINTS) {
      if (hint.test(url)) {
        return {
          blocked: true,
          kind: "login",
          detail: `URL suggests an auth wall: ${url}`,
        };
      }
    }
  }

  if (TWO_FACTOR_PATTERNS.some((p) => p.test(text) || p.test(url))) {
    return {
      blocked: true,
      kind: "two_factor",
      detail: "Two-factor or verification-code challenge detected.",
    };
  }

  // Skip multi-step check entirely for known ATS hosts — step indicators are expected.
  if (!knownAts && MULTI_STEP_PATTERNS.some((p) => p.test(text))) {
    return {
      blocked: true,
      kind: "multi_step_flow",
      detail: "Unusual or multi-step application flow detected; requires manual takeover.",
    };
  }

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
