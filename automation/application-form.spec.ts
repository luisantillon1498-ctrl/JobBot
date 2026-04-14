import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
import { createRunDir, payloadFromEnv, saveScreenshot, writeJson, writeMeta } from "./lib/artifacts";
import { detectBlockers } from "./lib/blockers";
import { fillGreenhouseApplicationForm, greenhouseSubmitButton, isGreenhouseJobUrl } from "./lib/greenhouse";
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

function pauseBeforeSubmit(): boolean {
  return process.env.JOBPAL_PAUSE_BEFORE_SUBMIT !== "0";
}

function submitAllowed(): boolean {
  return process.env.JOBPAL_ALLOW_SUBMIT === "1";
}

test.describe("Application form automation", () => {
  test("Greenhouse: fill, save artifacts, pause before optional submit", async ({ page }, testInfo) => {
    const url = jobUrl();
    test.skip(!url, "Set JOBPAL_JOB_URL to a Greenhouse posting (https://…greenhouse.io…).");

    expect(
      isGreenhouseJobUrl(url),
      "First supported ATS is Greenhouse; JOBPAL_JOB_URL must be a greenhouse.io URL."
    ).toBe(true);

    const paths = await createRunDir(outputBaseDir());
    const payload = payloadFromEnv();

    let status: RunStatus = { kind: "error", message: "not started" };

    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });

      const blocker = await detectBlockers(page);
      if (blocker.blocked) {
        await saveScreenshot(page, path.join(paths.runDir, `blocked-${blocker.kind}.png`));
        status = { kind: "blocked", blocker: blocker.kind, detail: blocker.detail };
        await writeMeta(paths, {
          jobUrl: url,
          site: "greenhouse",
          status,
          finalUrl: page.url(),
        });
        await writeJson(paths.payloadPath, { payload, fillReport: null, note: "blocked before fill" });

        test.skip(true, `[${blocker.kind}] ${blocker.detail}`);
        return;
      }

      const fillReport = await fillGreenhouseApplicationForm(page, payload);

      await writeJson(paths.payloadPath, {
        payload,
        fillReport,
        env: {
          JOBPAL_ALLOW_SUBMIT: process.env.JOBPAL_ALLOW_SUBMIT ?? "",
          JOBPAL_PAUSE_BEFORE_SUBMIT: process.env.JOBPAL_PAUSE_BEFORE_SUBMIT ?? "",
        },
      });

      await saveScreenshot(page, paths.screenshotPath);

      if (pauseBeforeSubmit()) {
        const headless = testInfo.project.use.headless !== false;
        if (headless) {
          testInfo.annotations.push({
            type: "jobpal",
            description:
              "Headless run: skipped page.pause(). Use --headed or set JOBPAL_PAUSE_BEFORE_SUBMIT=0 to avoid this note.",
          });
        } else {
          await page.pause();
        }
      }

      if (submitAllowed()) {
        const submit = greenhouseSubmitButton(page);
        if ((await submit.count()) === 0) {
          status = {
            kind: "filled",
            submitted: false,
            message: "Submit control not found; artifacts saved.",
          };
        } else {
          await submit.click();
          await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
          status = { kind: "filled", submitted: true };
        }
      } else {
        status = {
          kind: "filled",
          submitted: false,
          message:
            "Pause-before-submit: submission not sent (set JOBPAL_ALLOW_SUBMIT=1 after reviewing artifacts).",
        };
      }

      await writeMeta(paths, { jobUrl: url, site: "greenhouse", status, finalUrl: page.url() });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      status = { kind: "error", message };
      await saveScreenshot(page, path.join(paths.runDir, "error.png")).catch(() => {});
      let finalUrl = url;
      try {
        finalUrl = page.url();
      } catch {
        /* page may be closed */
      }
      await writeMeta(paths, {
        jobUrl: url,
        site: "greenhouse",
        status,
        finalUrl,
      });
      throw e;
    }

    expect(status.kind === "blocked", "blocked runs should have been skipped earlier").toBe(false);
  });
});
