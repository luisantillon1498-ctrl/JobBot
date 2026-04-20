import fs from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import type { ArtifactPaths } from "../types";
import { appendRunLog, saveDomSnapshot, saveScreenshot, writeJson } from "./artifacts";
import { detectHumanChallenge } from "./humanChallenge";

export function humanActionDoneSignalPath(): string | undefined {
  const p = process.env.JOBPAL_HUMAN_ACTION_DONE_FILE?.trim();
  return p || undefined;
}

export function humanChallengeTimeoutMs(): number {
  const raw = process.env.JOBPAL_HUMAN_CHALLENGE_TIMEOUT_MS?.trim();
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 1_800_000; // 30 minutes — enough time for most CAPTCHA solves
}

export async function saveHumanHandoffArtifacts(args: {
  paths: ArtifactPaths;
  page: Page;
  jobUrl: string;
  detail: string;
  headed: boolean;
}): Promise<void> {
  await saveScreenshot(args.page, path.join(args.paths.runDir, "human-challenge.png"));
  await saveDomSnapshot(args.page, path.join(args.paths.runDir, "dom-human-challenge.html"));
  await writeJson(args.paths.humanHandoffPath, {
    kind: "human_verification_required",
    createdAt: new Date().toISOString(),
    jobUrl: args.jobUrl,
    pageUrl: args.page.url(),
    detail: args.detail,
    headed: args.headed,
    resumeHints: {
      server:
        "The runner writes a done-signal file (JOBPAL_HUMAN_ACTION_DONE_FILE) when the user clicks Resume. " +
        "Playwright polls for this file and continues once it appears.",
      local:
        "When running locally without the runner, set JOBPAL_PAUSED_FILE and JOBPAL_HUMAN_ACTION_DONE_FILE " +
        "manually, or use Playwright Inspector (activePage.pause()) to interact with the live browser.",
    },
  });
  await appendRunLog(args.paths, "human_handoff_artifacts_saved");
}

/**
 * Waits for the resume signal file to appear, then deletes it and returns true.
 * Used in server-managed (production) mode: the runner writes the signal when the
 * user clicks "Resume Automation" in the app.
 */
export async function waitForResumeSignal(
  signalFile: string,
  timeoutMs: number,
  pollMs = 1000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fs.access(signalFile);
      // Found — delete it and return
      try { await fs.unlink(signalFile); } catch { /* ignore */ }
      return true;
    } catch {
      /* not present yet */
    }
    await new Promise<void>((r) => setTimeout(r, pollMs));
  }
  return false;
}

// ─── Submission auto-detection ────────────────────────────────────────────────

/** URL fragments that reliably indicate a successful ATS submission. */
const SUBMISSION_URL_PATTERNS: RegExp[] = [
  /[?&]success=true/i,               // Greenhouse: appends ?success=true
  /\/confirmation/i,                  // Workday, Taleo
  /\/thank[-_]?you/i,
  /\/success/i,
  /\/submitted/i,
  /\/application[-_]?complete/i,
  /\/applied/i,
];

/** Body-text phrases shown on ATS confirmation pages after submit. */
const SUBMISSION_TEXT_PATTERNS: RegExp[] = [
  /your application has been (submitted|received|sent)/i,
  /thank you for (applying|submitting|your application)/i,
  /application (received|submitted|complete|confirmed|on its way)/i,
  /we['']?ve received your application/i,
  /successfully (submitted|applied)/i,
  /your application is (complete|confirmed)/i,
  /you['']?ve applied/i,
  /application complete/i,
];

/**
 * Races two conditions while the browser is open for user review:
 *   1. Auto-detection: polls the live page every 2 s for submission confirmation
 *      (URL pattern or confirmation text). On detection, updates meta.json with
 *      kind:"submitted" and writes the done-signal itself.
 *   2. Manual resume: waits for the server to write the done-signal file (user
 *      clicked "Resume Automation").
 *
 * Returns { autoSubmitted: true } when submission was auto-detected, or
 * { autoSubmitted: false } when the user resumed manually (or timeout hit).
 */
export async function waitForSubmissionOrResume(
  page: Page,
  doneSignalFile: string,
  timeoutMs: number,
  onAutoSubmit: () => Promise<void>,
): Promise<{ autoSubmitted: boolean }> {
  let autoSubmitted = false;
  let cancelled = false;

  const detectionLoop = (async () => {
    const deadline = Date.now() + timeoutMs;
    while (!cancelled && Date.now() < deadline) {
      try {
        // Check URL first (cheap, no evaluate needed)
        const currentUrl = page.url();
        const urlMatch = SUBMISSION_URL_PATTERNS.some((p) => p.test(currentUrl));

        let textMatch = false;
        if (!urlMatch) {
          const bodyText: string = await page
            .evaluate(() => (document.body?.innerText ?? "").slice(0, 8000))
            .catch(() => "");
          textMatch = SUBMISSION_TEXT_PATTERNS.some((p) => p.test(bodyText));
        }

        if (urlMatch || textMatch) {
          autoSubmitted = true;
          console.log(`[spec] Submission detected (${urlMatch ? "url" : "text"}). Auto-marking as submitted.`);
          await onAutoSubmit();
          // Write the done-signal so the resume-poller unblocks and we exit cleanly.
          await fs.writeFile(doneSignalFile, "done").catch(() => {});
          return;
        }
      } catch {
        // Page may be mid-navigation — ignore and retry
      }
      // Poll every 2 seconds
      await new Promise<void>((r) => setTimeout(r, 2000));
    }
  })();

  // Also wait for the server-written done-signal (user clicked Resume manually)
  const manualResume = waitForResumeSignal(doneSignalFile, timeoutMs);

  await Promise.race([detectionLoop, manualResume]);
  cancelled = true;

  return { autoSubmitted };
}

/**
 * Polls the page until verification widgets/text are gone, or the optional
 * signal file appears (then unlinks it).  Used in local-dev / headless fallback.
 */
export async function waitUntilHumanChallengeCleared(
  page: Page,
  options: { timeoutMs: number; pollMs?: number; signalFile?: string },
): Promise<{ ok: boolean; reason?: string }> {
  const pollMs = options.pollMs ?? 3000;
  const deadline = Date.now() + options.timeoutMs;

  while (Date.now() < deadline) {
    if (options.signalFile) {
      try {
        await fs.access(options.signalFile);
        try { await fs.unlink(options.signalFile); } catch { /* ignore */ }
        // Signal received — trust the user and return success
        return { ok: true };
      } catch {
        /* not present */
      }
    }

    const { present } = await detectHumanChallenge(page);
    if (!present) return { ok: true };

    await new Promise<void>((r) => setTimeout(r, pollMs));
  }

  return { ok: false, reason: "Timed out waiting for human verification to clear." };
}
