import fs from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import type { ArtifactPaths } from "../types";
import { appendRunLog, saveDomSnapshot, saveScreenshot, writeJson } from "./artifacts";
import { detectHumanChallenge } from "./humanChallenge";

export function hasSteelSession(): boolean {
  return Boolean(process.env.JOBPAL_STEEL_SESSION_ID?.trim());
}

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
  return 900_000;
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
      headed:
        "Complete the check in the live Playwright browser window. In the Inspector, press Resume when verification is done; automation will recheck the page.",
      headless:
        "This run cannot expose a live browser. Re-run with Playwright --headed (or PWDEBUG=1) on a machine you control, or use a runner configured for interactive sessions.",
      optionalSignalFile:
        "If JOBPAL_HUMAN_ACTION_DONE_FILE is set to a filesystem path, creating that file signals completion; the file is deleted when observed and the page is rechecked.",
    },
  });
  await appendRunLog(args.paths, "human_handoff_artifacts_saved");
}

/**
 * Polls the main page until verification widgets/text are gone, or optional signal file appears (then unlink).
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
        try {
          await fs.unlink(options.signalFile);
        } catch {
          /* ignore */
        }
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
