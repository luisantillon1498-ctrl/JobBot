import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT ?? 8080);
const RUNNER_TOKEN = process.env.JOBPAL_AUTOMATION_RUNNER_TOKEN?.trim() || "";
const ROOT_DIR = path.resolve(process.cwd());
const RUN_TIMEOUT_MS = Number(process.env.JOBPAL_RUN_TIMEOUT_MS ?? 180000);
const STEEL_API_KEY = process.env.STEEL_API_KEY?.trim() || "";

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function shouldRejectForAuth(req) {
  if (!RUNNER_TOKEN) return false;
  const authHeader = req.headers.authorization ?? "";
  return authHeader !== `Bearer ${RUNNER_TOKEN}`;
}

function toSafeFileName(input, fallback) {
  const normalized = String(input ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, 120);
  return normalized || fallback;
}

async function downloadToFile(url, filePath) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Document download failed (${response.status})`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(filePath, bytes);
}

async function createSteelSession(timeoutMs) {
  console.log(`[steel] STEEL_API_KEY set: ${Boolean(STEEL_API_KEY)}`);
  if (!STEEL_API_KEY) return null;
  console.log(`[steel] Creating session with timeout ${timeoutMs}ms`);
  const res = await fetch("https://api.steel.dev/v1/sessions", {
    method: "POST",
    headers: { "Steel-Api-Key": STEEL_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ timeout: timeoutMs }),
  });
  if (!res.ok) {
    console.error(`[steel] Session create failed: ${res.status}`);
    return null;
  }
  const data = await res.json();
  console.log(`[steel] Session created: ${data.id}, liveViewUrl: ${data.sessionViewerUrl}`);
  return { sessionId: data.id, cdpUrl: data.websocketUrl, liveViewUrl: data.sessionViewerUrl };
}

async function releaseSteelSession(sessionId) {
  if (!STEEL_API_KEY || !sessionId) return;
  try {
    await fetch(`https://api.steel.dev/v1/sessions/${sessionId}/release`, {
      method: "POST",
      headers: { "Steel-Api-Key": STEEL_API_KEY },
    });
  } catch (err) {
    console.error("Steel session release failed:", err);
  }
}

function runPlaywright(env) {
  return new Promise((resolve, reject) => {
    const proc = spawn("npx playwright test automation/application-form.spec.ts --config automation/playwright.config.ts", {
      cwd: ROOT_DIR,
      env: { ...process.env, ...env },
      stdio: "pipe",
      shell: true,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
    }, RUN_TIMEOUT_MS);

    proc.stdout.on("data", (d) => {
      const chunk = d.toString();
      stdout += chunk;
      console.log("[pw]", chunk.trimEnd());
    });
    proc.stderr.on("data", (d) => {
      const chunk = d.toString();
      stderr += chunk;
      console.error("[pw:err]", chunk.trimEnd());
    });
    proc.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    proc.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code: code ?? 1, stdout, stderr, timedOut });
    });
  });
}

function mapMetaStatusToRunnerResult(metaStatus) {
  if (!metaStatus || typeof metaStatus !== "object") {
    return { status: "failed", hard_blocker: false, message: "Missing run meta status" };
  }

  if (metaStatus.kind === "waiting_for_human_action") {
    return {
      status: "waiting_for_human_action",
      hard_blocker: false,
      message: metaStatus.detail || "Human verification required before autofill can continue",
      unanswered_questions: [],
    };
  }

  if (metaStatus.kind === "blocked") {
    return {
      status: "blocked",
      hard_blocker: false,
      message: metaStatus.detail || "Run blocked",
      unanswered_questions: [],
    };
  }
  if (metaStatus.kind === "filled") {
    return {
      status: "waiting_for_review",
      hard_blocker: false,
      message: metaStatus.message || "Run completed and paused before submit",
    };
  }
  return {
    status: "failed",
    hard_blocker: false,
    message: metaStatus.message || "Run failed",
  };
}

function pickSkippedReason(output) {
  if (typeof output !== "string") return null;
  const marker = "Test is skipped:";
  const idx = output.indexOf(marker);
  if (idx === -1) return null;
  const snippet = output.slice(idx + marker.length).trim();
  const firstLine = snippet.split(/\r?\n/)[0]?.trim();
  return firstLine || "Run skipped for manual review";
}

function deriveUnansweredQuestions(runPayload) {
  const issues = runPayload?.fillReport?.mappingPlan?.issues;
  if (!Array.isArray(issues)) return [];

  return issues
    .filter((issue) => {
      if (!issue || typeof issue !== "object") return false;
      if (issue.target !== "work_authorization") return false;
      return issue.reason === "ambiguous" || issue.reason === "low_confidence";
    })
    .map((issue) => ({
      field: issue.target,
      reason: issue.reason,
      details: issue.details ?? "Unknown eligibility question requires manual review",
      candidate_selectors: Array.isArray(issue.candidateSelectors) ? issue.candidateSelectors : [],
    }));
}

async function runAutomation(payload) {
  const runId = randomUUID();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "jobpal-runner-"));
  const outputDir = path.join(tempDir, "output");
  await fs.mkdir(outputDir, { recursive: true });

  const cleanupPaths = [];
  let steelSession = null;
  try {
    steelSession = await createSteelSession(RUN_TIMEOUT_MS);

    const resumeSignedUrl = payload?.documents?.resume?.signed_url || null;
    const coverSignedUrl = payload?.documents?.cover_letter?.signed_url || null;
    let resumePath = "";
    let coverPath = "";

    if (resumeSignedUrl) {
      resumePath = path.join(tempDir, toSafeFileName(payload?.documents?.resume?.name, "resume.bin"));
      await downloadToFile(resumeSignedUrl, resumePath);
      cleanupPaths.push(resumePath);
    }
    if (coverSignedUrl) {
      coverPath = path.join(tempDir, toSafeFileName(payload?.documents?.cover_letter?.name, "cover-letter.bin"));
      await downloadToFile(coverSignedUrl, coverPath);
      cleanupPaths.push(coverPath);
    }

    const env = {
      JOBPAL_OUTPUT_DIR: outputDir,
      JOBPAL_APPLICATION_ID: String(payload?.application_id ?? ""),
      JOBPAL_USER_ID: String(payload?.user_id ?? ""),
      JOBPAL_JOB_URL: String(payload?.job_url ?? ""),
      JOBPAL_FIRST_NAME: String(payload?.applicant?.first_name ?? ""),
      JOBPAL_MIDDLE_NAME: String(payload?.applicant?.middle_name ?? ""),
      JOBPAL_LAST_NAME: String(payload?.applicant?.last_name ?? ""),
      JOBPAL_EMAIL: String(payload?.applicant?.email ?? ""),
      JOBPAL_PHONE: String(payload?.applicant?.phone ?? ""),
      JOBPAL_LINKEDIN_URL: String(payload?.applicant?.linkedin_url ?? ""),
      JOBPAL_LOCATION: String(payload?.applicant?.location ?? ""),
      JOBPAL_WORK_AUTHORIZATION: "",
      JOBPAL_SALARY_EXPECTATIONS: "",
      JOBPAL_RESUME_PATH: resumePath,
      JOBPAL_COVER_LETTER_PATH: coverPath,
    };

    if (steelSession) {
      env.JOBPAL_STEEL_CDP_URL = steelSession.cdpUrl;
      env.JOBPAL_STEEL_SESSION_ID = steelSession.sessionId;
      env.JOBPAL_STEEL_LIVE_URL = steelSession.liveViewUrl;
    }

    const proc = await runPlaywright(env);
    if (proc.timedOut) {
      return {
        httpStatus: 504,
        body: { status: "failed", hard_blocker: true, error: `Runner timed out after ${RUN_TIMEOUT_MS}ms` },
      };
    }

    const runEntries = await fs.readdir(outputDir, { withFileTypes: true });
    const runDirs = runEntries.filter((d) => d.isDirectory()).map((d) => path.join(outputDir, d.name));
    if (runDirs.length === 0) {
      return {
        httpStatus: 500,
        body: {
          status: "failed",
          hard_blocker: false,
          error: "No artifact output produced by automation run",
          message: proc.stderr || proc.stdout || "Automation exited without artifacts",
        },
      };
    }

    runDirs.sort();
    const latestRunDir = runDirs[runDirs.length - 1];
    const metaPath = path.join(latestRunDir, "meta.json");
    const payloadPath = path.join(latestRunDir, "payload.json");
    const runLogPath = path.join(latestRunDir, "run.log");
    const fieldMappingsPath = path.join(latestRunDir, "field-mappings.json");
    const humanHandoffPath = path.join(latestRunDir, "human-handoff.json");

    const [metaRaw, runPayloadRaw] = await Promise.all([
      fs.readFile(metaPath, "utf8"),
      fs.readFile(payloadPath, "utf8").catch(() => "{}"),
    ]);
    const meta = JSON.parse(metaRaw);
    const runPayload = JSON.parse(runPayloadRaw);

    const result = mapMetaStatusToRunnerResult(meta.status);
    if (steelSession && result.status === "waiting_for_human_action") {
      result.steel_live_url = steelSession.liveViewUrl;
      result.steel_session_id = steelSession.sessionId;
    }
    const unansweredQuestions = deriveUnansweredQuestions(runPayload);
    if (unansweredQuestions.length > 0) {
      result.status = "blocked";
      result.message = "Eligibility/work-authorization question requires manual review";
      result.unanswered_questions = unansweredQuestions;
    }
    const runnerBody = {
      ...result,
      final_url: meta.finalUrl ?? null,
      artifacts: {
        run_id: runId,
        run_dir: latestRunDir,
        meta_path: metaPath,
        payload_path: payloadPath,
        run_log_path: runLogPath,
        field_mappings_path: fieldMappingsPath,
        human_handoff_path: humanHandoffPath,
        files_uploaded: runPayload?.filesUploaded ?? [],
      },
    };

    const inlineSkipReason =
      typeof runnerBody.message === "string" && runnerBody.message.startsWith("Test is skipped:")
        ? runnerBody.message.replace(/^Test is skipped:\s*/, "").trim()
        : null;
    const skipReason = inlineSkipReason || pickSkippedReason(`${proc.stdout}\n${proc.stderr}`);
    if (skipReason && (runnerBody.status === "failed" || runnerBody.status === "waiting_for_review")) {
      runnerBody.status = "blocked";
      runnerBody.hard_blocker = false;
      runnerBody.message = skipReason;
    }

    if (proc.code !== 0 && runnerBody.status === "waiting_for_review") {
      return {
        httpStatus: 500,
        body: {
          status: "failed",
          hard_blocker: false,
          error: "Automation process exited non-zero",
          message: proc.stderr || proc.stdout || "Playwright process failed",
          final_url: runnerBody.final_url,
          artifacts: runnerBody.artifacts,
        },
      };
    }

    return {
      httpStatus: runnerBody.status === "failed" ? 500 : 200,
      body: runnerBody,
    };
  } finally {
    await releaseSteelSession(steelSession?.sessionId);
    for (const filePath of cleanupPaths) {
      await fs.rm(filePath, { force: true }).catch(() => {});
    }
  }
}

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    return sendJson(res, 200, { ok: true, service: "jobpal-automation-runner" });
  }

  if (req.method === "POST" && req.url === "/run") {
    try {
      if (shouldRejectForAuth(req)) {
        return sendJson(res, 401, { error: "Unauthorized runner token" });
      }

      const payload = await readJsonBody(req);
      if (!payload?.job_url || typeof payload.job_url !== "string") {
        return sendJson(res, 400, { error: "Missing required field: job_url" });
      }

      const result = await runAutomation(payload);
      return sendJson(res, result.httpStatus, result.body);
    } catch (error) {
      return sendJson(res, 500, {
        status: "failed",
        hard_blocker: false,
        error: error instanceof Error ? error.message : "Unexpected runner error",
      });
    }
  }

  return sendJson(res, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`JobPal runner listening on port ${PORT}`);
});
