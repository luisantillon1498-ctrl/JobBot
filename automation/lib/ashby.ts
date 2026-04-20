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
 * Navigate from an Ashby job listing page to the actual application form.
 * Ashby job URLs typically show a description page first; the form appears
 * after clicking the "Apply" button (which navigates to …/application).
 */
async function navigateToAshbyForm(page: Page): Promise<void> {
  // Let the page settle before probing — Ashby is a React SPA.
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

  // Only count visible, non-hidden inputs.  Hidden inputs (CSRF tokens etc.)
  // appear on the listing page and must not trigger an early return.
  const hasFormInputs = await page
    .locator("input:not([type='hidden']), textarea, select")
    .count()
    .catch(() => 0);
  if (hasFormInputs > 0) return;

  // Look for an Apply button/link on the listing page.
  const applySelectors = [
    'a[href*="/application"]',  // direct link to the /application route
    'a[href*="/apply"]',
    'button:has-text("Apply")',
    'a:has-text("Apply")',
    'button:has-text("Apply Now")',
    'a:has-text("Apply Now")',
  ];

  for (const sel of applySelectors) {
    const btn = page.locator(sel).first();
    if ((await btn.count()) > 0) {
      await btn.click();
      // Wait for navigation + React rendering to settle before probing inputs.
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
      await page
        .waitForSelector("input:not([type='hidden']), textarea, select", { timeout: 15_000 })
        .catch(() => {});
      return;
    }
  }
}

/**
 * Best-effort fill for Ashby-hosted public job application forms.
 */
export async function fillAshbyApplicationForm(page: Page, payload: ApplicantPayload): Promise<FillReport> {
  await navigateToAshbyForm(page);
  return fillAtsApplicationForm(page, payload, "ashby");
}
