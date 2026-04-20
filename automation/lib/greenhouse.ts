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
 * Resolve the Page context that contains the Greenhouse application form.
 *
 * job-boards.greenhouse.io renders the job description on the outer page and
 * embeds the actual application form in an iframe sourced from boards.greenhouse.io.
 * The older boards.greenhouse.io puts the form directly on the page (no iframe).
 *
 * Returns the frame's Page-like object if an embedded form iframe is found,
 * otherwise returns the top-level page.
 */
async function resolveGreenhouseFormFrame(page: Page): Promise<Page> {
  // Wait briefly for the page to settle before checking for iframes.
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

  // Look for an iframe sourced from greenhouse.io (the embedded application form).
  const frames = page.frames();
  for (const frame of frames) {
    const url = frame.url();
    if (url.includes("greenhouse.io") && frame !== page.mainFrame()) {
      // Confirm the iframe actually has form inputs before using it.
      const hasInputs = await frame.locator("input:not([type='hidden']), textarea, select").count().catch(() => 0);
      if (hasInputs > 0) {
        console.log(`[greenhouse] Using embedded form iframe: ${url}`);
        // Return the frame as a Page-compatible object for fillAtsApplicationForm
        return frame as unknown as Page;
      }
    }
  }

  // No form iframe found — form is directly on the page (boards.greenhouse.io style).
  return page;
}

/**
 * Best-effort fill for public Greenhouse job forms (boards / embeds).
 * Does not submit. Skips missing fields without throwing.
 */
export async function fillGreenhouseApplicationForm(page: Page, payload: ApplicantPayload): Promise<FillReport> {
  const formPage = await resolveGreenhouseFormFrame(page);
  return fillAtsApplicationForm(formPage, payload, "greenhouse");
}

export function greenhouseSubmitButton(page: Page): Locator {
  return page.getByRole("button", { name: /submit application|apply|submit/i }).first();
}
