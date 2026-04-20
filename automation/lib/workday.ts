import type { Page } from "@playwright/test";
import type { ApplicantPayload } from "../types";
import { fillAtsApplicationForm, type FillReport } from "./atsFormFill";
import { attemptResumeAutofill } from "./resumeAutofill";

export type { FillReport };

export function isWorkdayJobUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host.includes("myworkdayjobs.com") ||
      host.includes("wd103.myworkday.com") ||
      (host.includes("workday.com") && url.toLowerCase().includes("myworkdayjobs"))
    );
  } catch {
    return false;
  }
}

/**
 * Best-effort fill for Workday-hosted job application pages (when fields are in the main document).
 * Shadow-DOM-only widgets may limit mapping; unknown questions still pause via orchestrator policies.
 */
export async function fillWorkdayApplicationForm(page: Page, payload: ApplicantPayload): Promise<FillReport> {
  await attemptResumeAutofill(page, payload.resume_path ?? "");
  return fillAtsApplicationForm(page, payload, "workday");
}
