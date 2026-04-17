import type { Page } from "@playwright/test";
import type { ApplicantPayload } from "../types";
import { fillAtsApplicationForm, type FillReport } from "./atsFormFill";

export type { FillReport };

export function isAshbyJobUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.includes("ashbyhq.com");
  } catch {
    return false;
  }
}

/**
 * Best-effort fill for Ashby-hosted public job application forms.
 */
export async function fillAshbyApplicationForm(page: Page, payload: ApplicantPayload): Promise<FillReport> {
  return fillAtsApplicationForm(page, payload, "ashby");
}
