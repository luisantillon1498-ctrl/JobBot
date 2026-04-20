import type { Page } from "@playwright/test";

/** Button / clickable-div text patterns that indicate an autofill-from-resume trigger. */
const AUTOFILL_TRIGGER_PATTERNS = [
  /autofill.*resume/i,
  /resume.*autofill/i,
  /import.*resume/i,
  /parse.*resume/i,
  /upload.*resume/i,
  /resume.*upload/i,
  /upload your resume/i,
  /add.*resume/i,
];

/**
 * Looks for a "upload resume to autofill" trigger on the page and, if found,
 * uploads the resume file and waits for field pre-population.
 *
 * Returns true if autofill was triggered (the rest of the fill pass can skip
 * fields that are already populated).  Returns false if no trigger was found.
 *
 * Must be called BEFORE the manual fillAtsApplicationForm pass.
 */
export async function attemptResumeAutofill(page: Page, resumePath: string): Promise<boolean> {
  if (!resumePath) return false;

  // Candidate selectors for the autofill trigger — ordered by specificity.
  // We look for buttons/clickable elements that mention "upload" or "import"
  // near the top of the page, before form fields appear.
  const triggerSelectors = [
    'button:has-text("Upload your resume")',
    'button:has-text("Import resume")',
    'button:has-text("Autofill from resume")',
    'button:has-text("Parse resume")',
    '[role="button"]:has-text("Upload your resume")',
    '[role="button"]:has-text("Import resume")',
    // Ashby drop-zone is often a <div> with specific data-testid
    '[data-testid*="resume"][data-testid*="upload"]',
    '[data-testid*="upload"][data-testid*="resume"]',
    // Greenhouse: "Upload" button near the top before form fields
    'label:has-text("Upload"):not([for*="cover"]):not([for*="Cover"])',
  ];

  for (const sel of triggerSelectors) {
    const el = page.locator(sel).first();
    if ((await el.count()) === 0) continue;

    try {
      // Intercept the file-chooser event that the click opens
      const [fileChooser] = await Promise.all([
        page.waitForEvent("filechooser", { timeout: 3_000 }),
        el.click(),
      ]);
      await fileChooser.setFiles(resumePath);
      console.log(`[autofill] Resume uploaded via "${sel}" — waiting for field pre-population.`);

      // Wait up to 8 s for any name/email input to become non-empty
      await page
        .waitForFunction(
          () => {
            const inputs = Array.from(
              document.querySelectorAll("input:not([type='hidden']):not([type='file'])"),
            ) as HTMLInputElement[];
            return inputs.some((el) => el.value.trim().length > 0);
          },
          { timeout: 8_000 },
        )
        .catch(() => {
          /* autofill may be instant or may not populate anything — not fatal */
        });

      console.log("[autofill] Pre-population wait complete.");
      return true;
    } catch {
      // No file chooser opened or element not interactive — try next selector
    }
  }

  // No trigger found — fall through to manual fill
  return false;
}
