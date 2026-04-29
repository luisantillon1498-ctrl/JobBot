import type { Page } from "@playwright/test";
import type { ApplicantPayload } from "../types";
import { fillAtsApplicationForm, type FillReport } from "./atsFormFill";
import { attemptResumeAutofill } from "./resumeAutofill";

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
  // Use >= 3 so that 1-2 incidental inputs (e.g. search bars, cookie banners)
  // on the listing page don't short-circuit navigation to the actual form.
  const hasFormInputs = await page
    .locator("input:not([type='hidden']), textarea, select")
    .count()
    .catch(() => 0);
  if (hasFormInputs >= 3) return;

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
  await attemptResumeAutofill(page, payload.resume_path ?? "");

  // Scroll to the bottom so any lazy-rendered sections (e.g. EEO dropdowns)
  // are fully in the DOM before we scan for field candidates — mirrors the
  // Greenhouse approach that pre-loads the full form before extraction.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
  await page.waitForTimeout(800);
  // Scroll back to top so the user sees the form from the start.
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await page.waitForTimeout(300);

  return fillAtsApplicationForm(page, payload, "ashby");
}
