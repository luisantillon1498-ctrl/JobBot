import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import type { ApplicantPayload, ArtifactPaths, RunStatus } from "../types";

function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export async function createRunDir(baseDir: string): Promise<ArtifactPaths> {
  const runDir = path.join(baseDir, timestampSlug());
  await fs.mkdir(runDir, { recursive: true });
  return {
    runDir,
    metaPath: path.join(runDir, "meta.json"),
    payloadPath: path.join(runDir, "payload.json"),
    runLogPath: path.join(runDir, "run.log"),
    screenshotBeforePath: path.join(runDir, "before-fill.png"),
    screenshotAfterPath: path.join(runDir, "after-fill.png"),
    domSnapshotPath: path.join(runDir, "dom-snapshot.html"),
    fieldMappingsPath: path.join(runDir, "field-mappings.json"),
    humanHandoffPath: path.join(runDir, "human-handoff.json"),
  };
}

export async function writeJson(filePath: string, data: unknown): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

export async function appendRunLog(paths: ArtifactPaths, message: string): Promise<void> {
  const line = `${new Date().toISOString()} ${message}\n`;
  await fs.appendFile(paths.runLogPath, line, "utf8");
}

export async function saveScreenshot(page: Page, filePath: string): Promise<void> {
  await page.screenshot({ path: filePath, fullPage: true });
}

export async function saveDomSnapshot(page: Page, filePath: string): Promise<void> {
  const html = await page.content();
  await fs.writeFile(filePath, html, "utf8");
}

export async function writeMeta(
  paths: ArtifactPaths,
  fields: {
    jobUrl: string;
    site: string;
    status: RunStatus;
    finalUrl: string;
  }
): Promise<void> {
  await writeJson(paths.metaPath, {
    ...fields,
    savedAt: new Date().toISOString(),
  });
}

export function payloadFromEnv(): ApplicantPayload {
  return {
    first_name: process.env.JOBPAL_FIRST_NAME ?? undefined,
    middle_name: process.env.JOBPAL_MIDDLE_NAME ?? undefined,
    preferred_name: process.env.JOBPAL_PREFERRED_NAME ?? undefined,
    last_name: process.env.JOBPAL_LAST_NAME ?? undefined,
    email: process.env.JOBPAL_EMAIL ?? undefined,
    phone: process.env.JOBPAL_PHONE ?? undefined,
    linkedin_url: process.env.JOBPAL_LINKEDIN_URL ?? undefined,
    location: process.env.JOBPAL_LOCATION ?? undefined,
    work_authorization: process.env.JOBPAL_WORK_AUTHORIZATION ?? undefined,
    salary_expectations: process.env.JOBPAL_SALARY_EXPECTATIONS ?? undefined,
    resume_path: process.env.JOBPAL_RESUME_PATH ?? undefined,
    cover_letter_path: process.env.JOBPAL_COVER_LETTER_PATH ?? undefined,
  };
}

export function defaultOutputDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "output");
}
