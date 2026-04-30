import type { Locator, Page } from "@playwright/test";
import type { ApplicantPayload } from "../types";
import { fillAtsApplicationForm, type FieldMappingPlan, type FillReport } from "./atsFormFill";
import { attemptResumeAutofill } from "./resumeAutofill";

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

/** Human-readable labels for DB enum values — kept in sync with Settings.tsx. */
const GH_HUMAN_READABLE: Record<string, string> = {
  man: "Man", male: "Male", woman: "Woman", female: "Female",
  non_binary: "Non-Binary", other: "Other",
  prefer_not_to_say: "Prefer not to say",
  yes: "Yes", no: "No",
  not_a_protected_veteran: "I am not a protected veteran",
  protected_veteran: "I am a protected veteran",
  decline_to_answer: "I prefer not to answer",
  no_disability: "No, I do not have a disability",
  has_disability: "Yes, I have a disability",
};

/** Robust option matching — handles decline synonyms and gender aliases. */
function ghMatchesOption(displayValue: string, optionText: string): boolean {
  const norm = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const v = norm(displayValue);
  const o = norm(optionText);
  if (!v || !o) return false;
  if (o.includes(v) || v.includes(o)) return true;
  const declineTerms = ["decline", "prefer not", "choose not", "do not wish", "don t wish", "not to answer", "not wish", "don t want"];
  const vIsDecline = declineTerms.some((t) => v.includes(t));
  const oIsDecline = declineTerms.some((t) => o.includes(t));
  if (vIsDecline && oIsDecline) return true;
  if ((v === "man" || v === "male") && (o === "male" || o === "man" || o.startsWith("male") || o.startsWith("man"))) return true;
  if ((v === "woman" || v === "female") && (o.includes("female") || o.includes("woman"))) return true;
  if (v.includes("non binary") && (o.includes("non binary") || o.includes("nonbinary"))) return true;
  return false;
}

/**
 * Greenhouse EEO + Country dropdowns are custom React Select components.
 * extractFieldCandidates finds the hidden backing <input> and fill() sets
 * its value, but that doesn't update the visible dropdown. This helper
 * clicks the visible trigger and selects the matching option instead.
 */
async function fillGreenhouseCustomDropdowns(page: Page, payload: ApplicantPayload): Promise<void> {
  const fields: Array<{ labelPattern: RegExp; value: string | undefined; isCountry?: boolean }> = [
    { labelPattern: /\bcountry\b/i,             value: payload.country, isCountry: true },
    { labelPattern: /\bgender\b/i,              value: payload.gender },
    { labelPattern: /\bhispanic\b|\blatino\b/i, value: payload.hispanic_ethnicity },
    { labelPattern: /\bveteran\b/i,             value: payload.veteran_status },
    { labelPattern: /\bdisabilit/i,             value: payload.disability_status },
  ];

  for (const { labelPattern, value, isCountry } of fields) {
    if (!value) continue;
    const displayValue = GH_HUMAN_READABLE[value] ?? value;

    try {
      // Close any previously-open dropdown before targeting the next field.
      await page.keyboard.press("Escape").catch(() => {});

      // ── Find a label whose text matches this field ──────────────────────
      const allLabels = await page
        .locator("label, legend, .field-label, [class*='label' i]")
        .all();

      let triggerEl: import("@playwright/test").Locator | null = null;

      for (const label of allLabels) {
        const text = await label.textContent().catch(() => "");
        if (!text || !labelPattern.test(text)) continue;

        for (const ancestor of [
          label.locator("xpath=.."),
          label.locator("xpath=../.."),
          label.locator("xpath=../../.."),
        ]) {
          const btn = ancestor
            .locator(
              "button[aria-haspopup], [role='combobox'], .select-dropdown--button, [class*='select' i][class*='control' i]",
            )
            .first();
          if ((await btn.count()) > 0) {
            // For country: skip if this trigger is inside the phone widget
            if (isCountry) {
              const insidePhone = await btn
                .evaluate((el) => !!el.closest(".iti, .intl-tel-input, [data-intl-tel-input-id]"))
                .catch(() => false);
              if (insidePhone) continue;
            }
            triggerEl = btn;
            break;
          }

          const placeholder = ancestor.locator(":text('Select...')").first();
          if ((await placeholder.count()) > 0) {
            if (isCountry) {
              const insidePhone = await placeholder
                .evaluate((el) => !!el.closest(".iti, .intl-tel-input, [data-intl-tel-input-id]"))
                .catch(() => false);
              if (insidePhone) continue;
            }
            triggerEl = placeholder;
            break;
          }
        }
        if (triggerEl) break;
      }

      if (!triggerEl) {
        console.log(`[gh-dropdown] no trigger found for /${labelPattern.source}/`);
        continue;
      }

      await triggerEl.scrollIntoViewIfNeeded().catch(() => {});
      await triggerEl.click({ timeout: 4000 });
      await page.waitForTimeout(400);

      // ── Find and click the matching option ─────────────────────────────
      const optionLocator = page.locator(
        [
          // Only options in active dropdown menus (avoid phone-country widget collisions).
          ".select__menu:visible [role='option']",
          ".select-dropdown--menu:visible .select-dropdown--item",
          "[role='listbox']:visible [role='option']",
        ].join(", "),
      );
      const options = await optionLocator.all();
      let matched = false;
      for (const opt of options) {
        const isVisible = await opt.isVisible().catch(() => false);
        if (!isVisible) continue;
        const insidePhoneWidget = await opt
          .evaluate((el) => !!el.closest(".iti, .intl-tel-input, [data-intl-tel-input-id]"))
          .catch(() => false);
        if (insidePhoneWidget) continue;
        const optText = ((await opt.textContent().catch(() => "")) ?? "").trim();
        if (!optText) continue;
        // For country, skip phone dial code options (e.g. "United States +1")
        if (isCountry && /\+\d+/.test(optText)) continue;
        if (ghMatchesOption(displayValue, optText)) {
          await opt.click({ timeout: 3000, force: true });
          matched = true;
          console.log(`[gh-dropdown] ✓ "${optText}" for /${labelPattern.source}/`);
          break;
        }
      }

      // Fallback for combobox-style controls: type value and confirm with Enter.
      if (!matched) {
        const comboInput = page
          .locator(
            [
              "input[aria-autocomplete='list']:visible",
              "[role='combobox'] input:visible",
              ".select__control input:visible",
            ].join(", "),
          )
          .first();
        if ((await comboInput.count()) > 0) {
          await comboInput.fill("");
          await comboInput.type(displayValue, { delay: 20 });
          await page.waitForTimeout(200);
          await comboInput.press("Enter").catch(() => {});
          await page.waitForTimeout(200);
          matched = true;
          console.log(`[gh-dropdown] ↺ typed fallback "${displayValue}" for /${labelPattern.source}/`);
        }
      }

      if (!matched) {
        console.log(`[gh-dropdown] ✗ no option matched "${displayValue}" for /${labelPattern.source}/`);
        await page.keyboard.press("Escape").catch(() => {});
      }

      await page.waitForTimeout(200);
    } catch (err) {
      console.log(`[gh-dropdown] error for /${labelPattern.source}/: ${err}`);
    }
  }
}

/**
 * The Greenhouse "Location (City)" field uses Google Places Autocomplete.
 * Typing text and leaving triggers a clear if no suggestion is selected.
 * This helper types just the city name and selects the first autocomplete suggestion.
 */
async function fillGreenhouseLocationField(page: Page, payload: ApplicantPayload): Promise<void> {
  if (!payload.location) return;
  // Extract just the city (first part before any comma)
  const city = payload.location.split(",")[0].trim();
  if (!city) return;

  try {
    const locInput = page
      .locator("input[id*='location' i], input[name*='location' i], input[placeholder*='city' i]")
      .first();
    if ((await locInput.count()) === 0) return;

    await locInput.click({ timeout: 3000 });
    await locInput.fill("");
    await locInput.pressSequentially(city, { delay: 60 });
    await page.waitForTimeout(1200); // wait for autocomplete to populate

    // Try to select the first autocomplete suggestion
    const suggestion = page
      .locator(".pac-item:visible, [class*='autocomplete' i] li:visible, [class*='suggestion' i]:visible")
      .first();
    if ((await suggestion.count()) > 0) {
      await suggestion.click({ timeout: 3000 });
      console.log("[gh-location] selected autocomplete suggestion for city:", city);
    } else {
      // No autocomplete shown — commit the typed value with Tab
      await locInput.press("Tab");
      console.log("[gh-location] no autocomplete; committed city with Tab:", city);
    }
  } catch (err) {
    console.log("[gh-location] error:", err);
  }
}

/**
 * Best-effort fill for public Greenhouse job forms (boards / embeds).
 * Does not submit. Skips missing fields without throwing.
 */
export async function fillGreenhouseApplicationForm(page: Page, payload: ApplicantPayload): Promise<FillReport> {
  const formPage = await resolveGreenhouseFormFrame(page);
  await attemptResumeAutofill(formPage, payload.resume_path ?? "");

  // Scroll to the bottom of the form so any lazy-rendered sections (e.g. EEO
  // dropdowns at the bottom of the page) are fully in the DOM before we
  // scan for field candidates.
  await formPage.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
  await formPage.waitForTimeout(600);
  // Scroll back to top so the user sees the form from the start.
  await formPage.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await formPage.waitForTimeout(300);

  const report = await fillAtsApplicationForm(formPage, payload, "greenhouse");
  // EEO + Country dropdowns are custom React Select components — fill them separately.
  await fillGreenhouseCustomDropdowns(formPage, payload);
  await fillGreenhouseLocationField(formPage, payload);
  return report;
}

export function greenhouseSubmitButton(page: Page): Locator {
  return page.getByRole("button", { name: /submit application|apply|submit/i }).first();
}
