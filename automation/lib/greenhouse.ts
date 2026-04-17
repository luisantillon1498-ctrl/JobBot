import type { Locator, Page } from "@playwright/test";
import type { ApplicantPayload } from "../types";
import { fillAtsApplicationForm, type FieldMappingPlan, type FillReport } from "./atsFormFill";

export type { FieldMappingPlan, FillReport };

export function isGreenhouseJobUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.includes("greenhouse.io");
  } catch {
    return false;
  }
}

/**
 * Best-effort fill for public Greenhouse job forms (boards / embeds).
 * Does not submit. Skips missing fields without throwing.
 */
export async function fillGreenhouseApplicationForm(page: Page, payload: ApplicantPayload): Promise<FillReport> {
  return fillAtsApplicationForm(page, payload, "greenhouse");
}

export function greenhouseSubmitButton(page: Page): Locator {
  return page.getByRole("button", { name: /submit application|apply|submit/i }).first();
}
