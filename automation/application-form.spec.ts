import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
import { createRunDir, payloadFromEnv, saveDomSnapshot, saveScreenshot, writeJson, writeMeta } from "./lib/artifacts";
import { fillAshbyApplicationForm } from "./lib/ashby";
import { detectBlockers } from "./lib/blockers";
import { fillGreenhouseApplicationForm } from "./lib/greenhouse";
import {
  humanActionDoneSignalPath,
  humanChallengeTimeoutMs,
  saveHumanHandoffArtifacts,
  waitForResumeSignal,
  waitUntilHumanChallengeCleared,
} from "./lib/humanHandoff";
import { detectHumanChallenge } from "./lib/humanChallenge";
import { createOutcomeLogger } from "./lib/outcomeLogger";
import { detectAtsSiteFromUrl } from "./lib/siteDetection";
import { fillWorkdayApplicationForm } from "./lib/workday";
import type { RunStatus } from "./types";

const automationDir = path.dirname(fileURLToPath(import.meta.url));

function jobUrl(): string | undefined {
  const u = process.env.JOBPAL_JOB_URL?.trim();
  return u || undefined;
}

function outputBaseDir(): string {
  const override = process.env.JOBPAL_OUTPUT_DIR?.trim();
  if (override) return path.resolve(override);
  return path.resolve(automationDir, "output");
}

/** Path to the paused-signal file written by this spec when CAPTCHA is detected. */
function pausedFilePath(): string | undefined {
  return process.env.JOBPAL_PAUSED_FILE?.trim() || undefined;
}

const CRITICAL_FILL_FIELDS = ["first_name", "last_name", "email"] as const;

test.describe("Application form automation", () => {
  test("Fill form, save artifacts, and stop before submit", async ({ page }, testInfo) => {
    const url = jobUrl();
    test.skip(!url, "Set JOBPAL_JOB_URL to a job posting URL.");
    if (!url) return;

    // Always use the Playwright fixture page (no Steel / remote browser)
    const activePage = page;

    const paths = await createRunDir(outputBaseDir());
    const payload = payloadFromEnv();
    const site = detectAtsSiteFromUrl(url);
    const outcomeLogger = createOutcomeLogger(url);

    let status: RunStatus = { kind: "error", message: "not started" };

    try {
      await outcomeLogger.appendLocalAndSession(paths, "autofill_started");
      await outcomeLogger.logLifecycle({
        phase: "autofill_started",
        description: "Autofill started",
        context: { job_url: url, site },
        paths,
      });
      await outcomeLogger.logState({
        state: "autofilling",
        description: "Autofill in progress",
        context: { job_url: url, site },
        paths,
      });

      await activePage.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await saveScreenshot(activePage, paths.screenshotBeforePath);
      await outcomeLogger.syncSessionArtifacts(paths);

      const human = await detectHumanChallenge(activePage);
      if (human.present) {
        await outcomeLogger.appendLocalAndSession(paths, "human_verification_detected");
        await saveHumanHandoffArtifacts({
          paths,
          page: activePage,
          jobUrl: url,
          detail: human.detail,
          headed: true,
        });
        await outcomeLogger.logLifecycle({
          phase: "captcha_encountered",
          description: "Captcha or human verification encountered — pausing for human action",
          context: { detail: human.detail },
          paths,
          finalUrl: activePage.url(),
        });
        await outcomeLogger.logState({
          state: "waiting_for_human_action",
          description: "Waiting for human action (verification / captcha)",
          handoffReason: "human_verification",
          context: { handoff: "human_in_the_loop", detail: human.detail },
          paths,
          finalUrl: activePage.url(),
        });
        await outcomeLogger.syncSessionArtifacts(paths);

        const paused = pausedFilePath();
        const doneSignal = humanActionDoneSignalPath();

        if (paused && doneSignal) {
          // Production (server-managed) mode:
          // 1. Write paused-file so the server knows we're waiting.
          // 2. Block until the server writes the done-file (user clicked Resume).
          // 3. Continue with form filling — the CAPTCHA should be gone.
          await fs.writeFile(paused, "paused");
          await outcomeLogger.appendLocalAndSession(paths, "human_handoff_paused_signal_written");
          console.log(`[spec] Paused signal written. Waiting for resume at: ${doneSignal}`);

          const resumed = await waitForResumeSignal(doneSignal, humanChallengeTimeoutMs());
          if (!resumed) {
            status = { kind: "error", message: "Timed out waiting for human verification resume signal." };
            await writeMeta(paths, { jobUrl: url, site, status, finalUrl: activePage.url() });
            await outcomeLogger.logState({
              state: "failed",
              description: "Human verification timed out waiting for resume signal",
              reason: status.message,
              paths,
              finalUrl: activePage.url(),
            });
            throw new Error(status.message);
          }

          await outcomeLogger.logState({
            state: "human_action_completed",
            description: "Resume signal received — continuing autofill",
            paths,
            finalUrl: activePage.url(),
          });
          await outcomeLogger.appendLocalAndSession(paths, "human_challenge_cleared");
          await outcomeLogger.syncSessionArtifacts(paths);
          // Fall through — continue with blocker check and form fill
        } else {
          // Local dev mode (no server paused/done files configured):
          // Use Playwright Inspector so the developer can interact directly.
          await outcomeLogger.appendLocalAndSession(paths, "human_handoff_browser_active");
          await activePage.pause();
          const cleared = await waitUntilHumanChallengeCleared(activePage, {
            timeoutMs: humanChallengeTimeoutMs(),
            signalFile: doneSignal,
          });
          if (!cleared.ok) {
            status = { kind: "error", message: cleared.reason ?? "Human verification did not complete in time." };
            await writeMeta(paths, { jobUrl: url, site, status, finalUrl: activePage.url() });
            await outcomeLogger.appendLocalAndSession(paths, "human_handoff_timeout");
            await outcomeLogger.logState({
              state: "failed",
              description: "Human verification handoff timed out",
              reason: status.message,
              paths,
              finalUrl: activePage.url(),
            });
            throw new Error(status.message);
          }

          await outcomeLogger.logState({
            state: "human_action_completed",
            description: "Human action completed — verification cleared; resuming same browser session",
            paths,
            finalUrl: activePage.url(),
          });
          await outcomeLogger.appendLocalAndSession(paths, "human_challenge_cleared");
          await outcomeLogger.syncSessionArtifacts(paths);
        }
      }

      const blocker = await detectBlockers(activePage);
      if (blocker.blocked) {
        const blockedShotPath = path.join(paths.runDir, `blocked-${blocker.kind}.png`);
        await saveScreenshot(activePage, blockedShotPath);
        await outcomeLogger.appendLocalAndSession(paths, `handoff:${blocker.kind}`);
        status = { kind: "blocked", blocker: blocker.kind, detail: blocker.detail };
        await writeMeta(paths, { jobUrl: url, site, status, finalUrl: activePage.url() });
        await writeJson(paths.payloadPath, {
          payload,
          fillReport: null,
          note: "blocked before fill",
          filesUploaded: [],
          readyForUserReview: false,
        });
        const humanHandoffKinds = ["login", "two_factor", "multi_step_flow"] as const;
        const isHumanHandoff = (humanHandoffKinds as readonly string[]).includes(blocker.kind);
        if (isHumanHandoff) {
          await outcomeLogger.logLifecycle({
            phase: "waiting_for_human_action",
            description: "Automation paused — human action required before autofill can continue",
            context: { blocker_kind: blocker.kind, detail: blocker.detail },
            paths,
            finalUrl: activePage.url(),
          });
          await outcomeLogger.logState({
            state: "waiting_for_human_action",
            description: "Waiting for human action (handoff)",
            handoffReason: blocker.kind,
            context: { blocker_kind: blocker.kind, detail: blocker.detail },
            paths,
            finalUrl: activePage.url(),
          });
        } else {
          await outcomeLogger.logState({
            state: "failed",
            description: `Run failed: ${blocker.kind}`,
            reason: blocker.detail,
            context: { blocker_kind: blocker.kind },
            paths,
            finalUrl: activePage.url(),
          });
        }
        await outcomeLogger.syncSessionArtifacts(paths, [blockedShotPath]);

        test.skip(true, `[${blocker.kind}] ${blocker.detail}`);
        return;
      }

      if (site === "unknown") {
        const unknownDetail =
          "Unknown ATS/site type. Supported autofill targets: Greenhouse, Workday (myworkdayjobs.com), Ashby (ashbyhq.com).";
        status = { kind: "error", message: unknownDetail };
        await writeMeta(paths, { jobUrl: url, site, status, finalUrl: activePage.url() });
        await writeJson(paths.payloadPath, {
          payload,
          fillReport: null,
          note: "blocked due to unsupported site",
          filesUploaded: [],
          readyForUserReview: false,
        });
        await outcomeLogger.appendLocalAndSession(paths, "failed:unknown_site");
        await outcomeLogger.logState({
          state: "failed",
          description: "Run failed: unsupported site",
          reason: status.message,
          context: { site },
          paths,
          finalUrl: activePage.url(),
        });
        test.skip(true, status.message);
        return;
      }

      const fillReport =
        site === "greenhouse"
          ? await fillGreenhouseApplicationForm(activePage, payload)
          : site === "workday"
            ? await fillWorkdayApplicationForm(activePage, payload)
            : await fillAshbyApplicationForm(activePage, payload);
      await saveScreenshot(activePage, paths.screenshotAfterPath);
      await saveDomSnapshot(activePage, paths.domSnapshotPath);
      await writeJson(paths.fieldMappingsPath, {
        mappingPlan: fillReport.mappingPlan,
        fieldMappings: fillReport.fieldMappings,
      });
      await outcomeLogger.syncSessionArtifacts(paths);

      const appliedKeys = Object.keys(fillReport.applied);
      const hasCriticalFill = CRITICAL_FILL_FIELDS.some((key) => key in fillReport.applied);
      if (appliedKeys.length === 0 || !hasCriticalFill) {
        status = {
          kind: "error",
          message: "Form was not meaningfully filled (no critical fields applied).",
        };
        await writeJson(paths.payloadPath, {
          payload,
          fillReport,
          filesUploaded: fillReport.filesUploaded,
          readyForUserReview: false,
          note: "blocked due to empty or non-critical fill",
        });
        await writeMeta(paths, { jobUrl: url, site, status, finalUrl: activePage.url() });
        await outcomeLogger.appendLocalAndSession(paths, "failed:insufficient_fill");
        await outcomeLogger.logState({
          state: "failed",
          description: "Run failed: form not meaningfully filled",
          reason: status.message,
          context: { applied_keys: appliedKeys },
          paths,
          finalUrl: activePage.url(),
        });
        throw new Error(status.message);
      }

      await writeJson(paths.payloadPath, {
        payload,
        fillReport,
        filesUploaded: fillReport.filesUploaded,
        readyForUserReview: true,
      });
      await outcomeLogger.logLifecycle({
        phase: "autofill_completed",
        description: "Autofill completed — screenshots, logs, and field mappings saved",
        context: { files_uploaded: fillReport.filesUploaded },
        paths,
        finalUrl: activePage.url(),
      });
      await outcomeLogger.appendLocalAndSession(paths, "waiting_for_review");
      await outcomeLogger.logState({
        state: "waiting_for_review",
        description: "Waiting for review before submission",
        context: { files_uploaded: fillReport.filesUploaded },
        paths,
        finalUrl: activePage.url(),
      });

      status = {
        kind: "filled",
        submitted: false,
        readyForUserReview: true,
        message: "Form filled and artifacts saved. Stopped before submit for explicit user review.",
      };

      /** Do not advance to `ready_to_submit` here — that is a post-review user action in the app. */
      await outcomeLogger.syncSessionArtifacts(paths);
      await writeMeta(paths, { jobUrl: url, site, status, finalUrl: activePage.url() });
      await outcomeLogger.appendLocalAndSession(paths, "run_complete");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      status = { kind: "error", message };
      const errorShotPath = path.join(paths.runDir, "error.png");
      await saveScreenshot(activePage, errorShotPath).catch(() => {});
      await outcomeLogger.syncSessionArtifacts(paths, [errorShotPath]).catch(() => {});
      let finalUrl = url;
      try {
        finalUrl = activePage.url();
      } catch {
        /* page may be closed */
      }
      await writeMeta(paths, { jobUrl: url, site, status, finalUrl });
      await outcomeLogger.appendLocalAndSession(paths, `failed:${message}`);
      await outcomeLogger.logState({
        state: "failed",
        description: "Autofill run failed",
        reason: message,
        context: { error_name: e instanceof Error ? e.name : "unknown" },
        paths,
        finalUrl,
      });
      throw e;
    }

    expect(status.kind === "blocked", "blocked runs should have been skipped earlier").toBe(false);
  });
});
