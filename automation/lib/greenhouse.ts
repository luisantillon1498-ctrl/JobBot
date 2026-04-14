import * as fs from "node:fs";
import type { Locator, Page } from "@playwright/test";
import type { ApplicantPayload } from "../types";

export function isGreenhouseJobUrl(url: string): boolean {
  try {
    return new URL(url).hostname.includes("greenhouse.io");
  } catch {
    return false;
  }
}

export type FillReport = {
  applied: Record<string, string>;
  skippedEmpty: string[];
  notFound: string[];
};

async function tryFillByLabel(page: Page, labelPattern: RegExp, value: string): Promise<boolean> {
  const loc = page.getByLabel(labelPattern).first();
  if ((await loc.count()) === 0) return false;
  await loc.fill(value);
  return true;
}

async function tryFillByName(page: Page, name: string, value: string): Promise<boolean> {
  const loc = page.locator(`input[name="${name}"], textarea[name="${name}"]`).first();
  if ((await loc.count()) === 0) return false;
  await loc.fill(value);
  return true;
}

/**
 * Best-effort fill for public Greenhouse job forms (boards / embeds).
 * Does not submit. Skips missing fields without throwing.
 */
export async function fillGreenhouseApplicationForm(page: Page, payload: ApplicantPayload): Promise<FillReport> {
  const applied: Record<string, string> = {};
  const skippedEmpty: string[] = [];
  const notFound: string[] = [];

  const tryField = async (
    key: keyof ApplicantPayload,
    value: string | undefined,
    attempts: Array<() => Promise<boolean>>
  ) => {
    if (!value?.trim()) {
      skippedEmpty.push(key);
      return;
    }
    const v = value.trim();
    for (const run of attempts) {
      if (await run()) {
        applied[key] = v;
        return;
      }
    }
    notFound.push(key);
  };

  await tryField("first_name", payload.first_name, [
    () => tryFillByLabel(page, /^first name$/i, payload.first_name!),
    () => tryFillByName(page, "job_application[first_name]", payload.first_name!),
  ]);

  await tryField("last_name", payload.last_name, [
    () => tryFillByLabel(page, /^last name$/i, payload.last_name!),
    () => tryFillByName(page, "job_application[last_name]", payload.last_name!),
  ]);

  await tryField("email", payload.email, [
    () => tryFillByLabel(page, /^email$/i, payload.email!),
    () => tryFillByName(page, "job_application[email]", payload.email!),
  ]);

  await tryField("phone", payload.phone, [
    () => tryFillByLabel(page, /^phone|^mobile/i, payload.phone!),
    () => tryFillByName(page, "job_application[phone]", payload.phone!),
  ]);

  if (payload.resume_path?.trim()) {
    const p = payload.resume_path.trim();
    if (!fs.existsSync(p)) {
      notFound.push("resume_path");
    } else {
      const fileInput = page.locator('input[type="file"]').first();
      if ((await fileInput.count()) === 0) {
        notFound.push("resume_path");
      } else {
        await fileInput.setInputFiles(p);
        applied.resume_path = p;
      }
    }
  } else {
    skippedEmpty.push("resume_path");
  }

  return { applied, skippedEmpty, notFound };
}

export function greenhouseSubmitButton(page: Page): Locator {
  return page.getByRole("button", { name: /submit application|apply|submit/i }).first();
}
