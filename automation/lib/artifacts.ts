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
    screenshotPath: path.join(runDir, "before-submit.png"),
  };
}

export async function writeJson(filePath: string, data: unknown): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

export async function saveScreenshot(page: Page, filePath: string): Promise<void> {
  await page.screenshot({ path: filePath, fullPage: true });
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
    last_name: process.env.JOBPAL_LAST_NAME ?? undefined,
    email: process.env.JOBPAL_EMAIL ?? undefined,
    phone: process.env.JOBPAL_PHONE ?? undefined,
    resume_path: process.env.JOBPAL_RESUME_PATH ?? undefined,
  };
}

export function defaultOutputDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "output");
}
