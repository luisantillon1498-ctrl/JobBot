import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, test, expect } from "@playwright/test";
import { createRunDir, payloadFromEnv, saveDomSnapshot, saveScreenshot, writeJson, writeMeta } from "./lib/artifacts";
import { fillAshbyApplicationForm } from "./lib/ashby";
import { detectBlockers } from "./lib/blockers";
import { fillGreenhouseApplicationForm } from "./lib/greenhouse";
import {
  hasSteelSession,
  humanActionDoneSignalPath,
  humanChallengeTimeoutMs,
  saveHumanHandoffArtifacts,
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

const CRITICAL_FILL_FIELDS = ["first_name", "last_name", "email"] as const;

test.describe("Application form automation", () => {
  test("Fill form, save artifacts, and stop before submit", async ({ page }, testInfo) => {
    const url = jobUrl();
    test.skip(!url, "Set JOBPAL_JOB_URL to a job posting URL.");
    if (!url) return;

    // Connect to Steel.dev remote browser if CDP URL is provided, else use fixture page
    const steelCdpUrl = process.env.JOBPAL_STEEL_CDP_URL?.trim();
    let activePage = page; // default: use Playwright fixture page
    let steelBrowser: import("@playwright/test").Browser | null = null;

    if (steelCdpUrl) {
      try {
        console.log(`[steel] Connecting via CDP: ${steelCdpUrl}`);
        steelBrowser = await chromium.connectOverCDP(steelCdpUrl);
        const steelContext = steelBrowser.contexts()[0];
        activePage = steelContext.pages()[0] ?? await steelContext.newPage();
        console.log("[steel] CDP connection established");
      } catch (cdpErr) {
        console.error("[steel] CDP connection failed, falling back to local browser:", cdpErr);
        steelBrowser = null;
        // activePage stays as the local Playwright fixture page
      }
    }

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

      const headed = testInfo.project.use.headless === false;
      const human = await detectHumanChallenge(activePage);
      if (human.present) {
        await outcomeLogger.appendLocalAndSession(paths, "human_verification_detected");
        await saveHumanHandoffArtifacts({
          paths,
          page: activePage,
          jobUrl: url,
          detail: human.detail,
          headed,
        });
        await outcomeLogger.logLifecycle({
          phase: "captcha_encountered",
          description: "Captcha or human verification encountered — pausing for human action",
          context: { detail: human.detail, headed },
          paths,
          finalUrl: activePage.url(),
        });
        await outcomeLogger.logState({
          state: "waiting_for_human_action",
          description: "Waiting for human action (verification / captcha)",
          handoffReason: "human_verification",
          context: { handoff: "human_in_the_loop", headed, detail: human.detail },
          paths,
          finalUrl: activePage.url(),
        });
        await outcomeLogger.syncSessionArtifacts(paths);

        // In headless mode (production runner), exit immediately and surface the Steel live URL.
        // The Steel session stays alive so the user can solve the challenge in the iframe.
        // In headed mode (local dev), pause so the developer can interact directly.
        if (!headed) {
          status = { kind: "waiting_for_human_action", detail: human.detail };
          await writeMeta(paths, { jobUrl: url, site, status, finalUrl: activePage.url() });
          await writeJson(paths.payloadPath, {
            payload,
            fillReport: null,
            note: hasSteelSession() ? "human_verification_steel_live_session" : "human_verification_requires_headed_browser",
            filesUploaded: [],
            readyForUserReview: false,
          });
          await outcomeLogger.appendLocalAndSession(paths, "human_handoff_headless_exit");
          await outcomeLogger.logLifecycle({
            phase: "run_suspended_headless",
            description: hasSteelSession()
              ? "Run suspended: human verification required — Steel live session active for manual solve"
              : "Run suspended: human verification requires a headed browser; queue remains waiting for human action (not a failure)",
            context: { detail: human.detail, steel: hasSteelSession() },
            paths,
            finalUrl: activePage.url(),
          });
          await outcomeLogger.syncSessionArtifacts(paths);
          return;
        }

        // Headed (local dev only): pause so developer can interact.
        await outcomeLogger.appendLocalAndSession(paths, "human_handoff_browser_active");
        await activePage.pause();
        const cleared = await waitUntilHumanChallengeCleared(activePage, {
          timeoutMs: humanChallengeTimeoutMs(),
          signalFile: humanActionDoneSignalPath(),
        });
        if (!cleared.ok) {
          status = {
            kind: "error",
            message: cleared.reason ?? "Human verification did not complete in time.",
          };
          await writeMeta(paths, { jobUrl: url, site, status, finalUrl: activePage.url() });
          await outcomeLogger.appendLocalAndSession(paths, "human_handoff_timeout");
          await outcomeLogger.logState({
            state: "failed",
            description: "Human verification handoff timed out or session could not be resumed",
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

      const blocker = await detectBlockers(activePage);
      if (blocker.blocked) {
        const blockedShotPath = path.join(paths.runDir, `blocked-${blocker.kind}.png`);
        await saveScreenshot(activePage, blockedShotPath);
        await outcomeLogger.appendLocalAndSession(paths, `handoff:${blocker.kind}`);
        status = { kind: "blocked", blocker: blocker.kind, detail: blocker.detail };
        await writeMeta(paths, {
          jobUrl: url,
          site,
          status,
          finalUrl: activePage.url(),
        });
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
      await writeMeta(paths, {
        jobUrl: url,
        site,
        status,
        finalUrl,
      });
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
    } finally {
      if (steelBrowser) await steelBrowser.close().catch(() => {});
    }

    expect(status.kind === "blocked", "blocked runs should have been skipped earlier").toBe(false);
  });
});
