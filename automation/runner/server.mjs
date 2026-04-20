import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import { createReadStream, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import net from "node:net";

const PORT = Number(process.env.PORT ?? 8080);
const RUNNER_TOKEN = process.env.JOBPAL_AUTOMATION_RUNNER_TOKEN?.trim() || "";
const ROOT_DIR = path.resolve(process.cwd());
// Long timeout to accommodate CAPTCHA solve time
const RUN_TIMEOUT_MS = Number(process.env.JOBPAL_RUN_TIMEOUT_MS ?? 1_800_000);

// Supabase REST — used to write final state after a fire-and-forget /resume
const SUPABASE_URL = (process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";

// websockify listens on this port (bridges WebSocket → VNC :5900)
const VNC_WS_PORT = 6080;
// noVNC static files (installed by `apt-get install novnc`)
const NOVNC_STATIC = "/usr/share/novnc";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript",
  ".css":  "text/css",
  ".png":  "image/png",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/**
 * Active CAPTCHA handoff sessions keyed by application_id.
 * Stored so that POST /resume can signal them without restarting Playwright.
 */
const activeSessions = new Map();
// Map<appId, { proc, doneFile, exitPromise, tempDir, outputDir, cleanupPaths, runId }>

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
  if (!response.ok) throw new Error(`Document download failed (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(filePath, bytes);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForFile(filePath, timeoutMs, pollMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      await sleep(pollMs);
    }
  }
  return false;
}

function getRunnerPublicUrl() {
  // RAILWAY_PUBLIC_DOMAIN is injected automatically by Railway (e.g. "foo.up.railway.app").
  // Fall back to JOBPAL_AUTOMATION_RUNNER_URL for local dev or non-Railway deployments.
  const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN?.trim();
  if (railwayDomain) return `https://${railwayDomain}`;
  const explicit = (process.env.JOBPAL_AUTOMATION_RUNNER_URL ?? "").trim();
  return explicit.replace(/\/run\/?$/, "").replace(/\/$/, "");
}

function buildVncUrl() {
  const base = getRunnerPublicUrl();
  // noVNC will connect to wss://<same host>/vnc-ws automatically because
  // path=vnc-ws is a relative WebSocket path from the page origin.
  return `${base}/vnc/vnc.html?path=vnc-ws&autoconnect=1&resize=scale`;
}

// ─── Xvfb / VNC startup ──────────────────────────────────────────────────────

function startXvfb() {
  return new Promise((resolve, reject) => {
    console.log("[xvfb] Starting Xvfb :99 ...");
    const proc = spawn("Xvfb", [":99", "-screen", "0", "1280x900x24", "-ac"], {
      stdio: "pipe",
      detached: false,
    });
    proc.stderr.on("data", (d) => console.error("[xvfb]", d.toString().trimEnd()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== null) console.error(`[xvfb] exited with code ${code}`);
    });
    // Give Xvfb 1.5 s to initialise
    setTimeout(() => {
      console.log("[xvfb] Ready");
      resolve(proc);
    }, 1500);
  });
}

function startX11vnc() {
  console.log("[x11vnc] Starting on :5900 ...");
  const proc = spawn(
    "x11vnc",
    ["-display", ":99", "-nopw", "-listen", "localhost", "-xkb", "-forever", "-shared", "-quiet", "-rfbport", "5900"],
    { stdio: "pipe", detached: false },
  );
  proc.stderr.on("data", (d) => console.error("[x11vnc]", d.toString().trimEnd()));
  proc.on("error", (e) => console.error("[x11vnc] error:", e.message));
  proc.on("close", (code) => {
    if (code !== null) console.error(`[x11vnc] exited with code ${code}`);
  });
  console.log("[x11vnc] Launched");
  return proc;
}

function startWebsockify() {
  console.log("[websockify] Starting :6080 → localhost:5900 ...");
  // No --web flag: we serve noVNC static files ourselves (allows Node to serve on 8080)
  const proc = spawn("websockify", ["6080", "localhost:5900"], {
    stdio: "pipe",
    detached: false,
  });
  proc.stdout.on("data", (d) => console.log("[websockify]", d.toString().trimEnd()));
  proc.stderr.on("data", (d) => console.error("[websockify]", d.toString().trimEnd()));
  proc.on("error", (e) => console.error("[websockify] error:", e.message));
  proc.on("close", (code) => {
    if (code !== null) console.error(`[websockify] exited with code ${code}`);
  });
  console.log("[websockify] Launched");
  return proc;
}

// ─── Playwright spawning ──────────────────────────────────────────────────────

function spawnPlaywright(env) {
  return spawn(
    "npx",
    ["playwright", "test", "automation/application-form.spec.ts", "--config", "automation/playwright.config.ts"],
    {
      cwd: ROOT_DIR,
      env: { ...process.env, ...env },
      stdio: "pipe",
      shell: false,
    },
  );
}

// Returns a Promise that resolves to { code, stdout, stderr } when proc exits.
// Also starts streaming logs immediately.
function trackProc(proc) {
  let stdout = "";
  let stderr = "";
  const exitPromise = new Promise((resolve) => {
    proc.stdout.on("data", (d) => {
      const s = d.toString();
      stdout += s;
      console.log("[pw]", s.trimEnd());
    });
    proc.stderr.on("data", (d) => {
      const s = d.toString();
      stderr += s;
      console.error("[pw:err]", s.trimEnd());
    });
    proc.on("error", (err) => {
      console.error("[pw] spawn error:", err.message);
      resolve({ code: 1, stdout, stderr });
    });
    proc.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
  // Expose getter so callers can read partial output
  exitPromise._getStdout = () => stdout;
  exitPromise._getStderr = () => stderr;
  return exitPromise;
}

// ─── Artifact helpers ─────────────────────────────────────────────────────────

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
    return { status: "blocked", hard_blocker: false, message: metaStatus.detail || "Run blocked", unanswered_questions: [] };
  }
  if (metaStatus.kind === "filled") {
    return { status: "waiting_for_review", hard_blocker: false, message: metaStatus.message || "Run completed and paused before submit" };
  }
  if (metaStatus.kind === "submitted") {
    return { status: "submitted", hard_blocker: false, message: metaStatus.message || "Application submitted by user" };
  }
  return { status: "failed", hard_blocker: false, message: metaStatus.message || "Run failed" };
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

async function readArtifacts(outputDir, runId, procResult) {
  const runEntries = await fs.readdir(outputDir, { withFileTypes: true }).catch(() => []);
  const runDirs = runEntries.filter((d) => d.isDirectory()).map((d) => path.join(outputDir, d.name));

  if (runDirs.length === 0) {
    return {
      httpStatus: 500,
      body: {
        status: "failed",
        hard_blocker: false,
        error: "No artifact output produced by automation run",
        message: procResult.stderr || procResult.stdout || "Automation exited without artifacts",
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

  let meta, runPayload;
  try {
    meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
    runPayload = JSON.parse(await fs.readFile(payloadPath, "utf8").catch(() => "{}"));
  } catch {
    return { httpStatus: 500, body: { status: "failed", hard_blocker: false, error: "Could not parse run artifacts" } };
  }

  const result = mapMetaStatusToRunnerResult(meta.status);
  const unansweredQuestions = deriveUnansweredQuestions(runPayload);
  if (unansweredQuestions.length > 0) {
    result.status = "blocked";
    result.message = "Eligibility/work-authorization question requires manual review";
    result.unanswered_questions = unansweredQuestions;
  }

  // Collect fields the bot found on the form but had no profile data for
  const unfilledFields = (runPayload?.fillReport?.mappingPlan?.issues ?? [])
    .filter((issue) => issue.reason === "missing_payload" || issue.reason === "not_found")
    .map((issue) => ({
      field: issue.target,
      reason: issue.reason,
      details: issue.details ?? null,
    }));

  const runnerBody = {
    ...result,
    final_url: meta.finalUrl ?? null,
    unfilled_fields: unfilledFields,
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
  const skipReason = inlineSkipReason || pickSkippedReason(`${procResult.stdout}\n${procResult.stderr}`);
  if (skipReason && (runnerBody.status === "failed" || runnerBody.status === "waiting_for_review")) {
    runnerBody.status = "blocked";
    runnerBody.hard_blocker = false;
    runnerBody.message = skipReason;
  }

  if (procResult.code !== 0 && runnerBody.status === "waiting_for_review") {
    return {
      httpStatus: 500,
      body: {
        status: "failed",
        hard_blocker: false,
        error: "Automation process exited non-zero",
        message: procResult.stderr || procResult.stdout || "Playwright process failed",
        final_url: runnerBody.final_url,
        artifacts: runnerBody.artifacts,
      },
    };
  }

  return { httpStatus: runnerBody.status === "failed" ? 500 : 200, body: runnerBody };
}

// ─── Main automation runner ───────────────────────────────────────────────────

async function runAutomation(payload) {
  const appId = String(payload?.application_id ?? "");
  const runId = randomUUID();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "jobpal-runner-"));
  const outputDir = path.join(tempDir, "output");
  await fs.mkdir(outputDir, { recursive: true });

  const cleanupPaths = [];

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

  // Signal files for CAPTCHA handoff
  const pausedFile = path.join(tempDir, "paused.signal");
  const doneFile = path.join(tempDir, "done.signal");

  const env = {
    JOBPAL_OUTPUT_DIR: outputDir,
    JOBPAL_APPLICATION_ID: appId,
    JOBPAL_USER_ID: String(payload?.user_id ?? ""),
    JOBPAL_JOB_URL: String(payload?.job_url ?? ""),
    JOBPAL_FIRST_NAME: String(payload?.applicant?.first_name ?? ""),
    JOBPAL_MIDDLE_NAME: String(payload?.applicant?.middle_name ?? ""),
    JOBPAL_LAST_NAME: String(payload?.applicant?.last_name ?? ""),
    JOBPAL_EMAIL: String(payload?.applicant?.email ?? ""),
    JOBPAL_PHONE: String(payload?.applicant?.phone ?? ""),
    JOBPAL_LINKEDIN_URL: String(payload?.applicant?.linkedin_url ?? ""),
    JOBPAL_LOCATION: String(payload?.applicant?.location ?? ""),
    JOBPAL_WORK_AUTHORIZATION: String(payload?.applicant?.work_authorization ?? ""),
    JOBPAL_SALARY_EXPECTATIONS: String(payload?.applicant?.salary_expectations ?? ""),
    JOBPAL_VETERAN_STATUS: String(payload?.applicant?.veteran_status ?? ""),
    JOBPAL_DISABILITY_STATUS: String(payload?.applicant?.disability_status ?? ""),
    JOBPAL_GENDER: String(payload?.applicant?.gender ?? ""),
    JOBPAL_HISPANIC_ETHNICITY: String(payload?.applicant?.hispanic_ethnicity ?? ""),
    JOBPAL_COUNTRY: String(payload?.applicant?.country ?? ""),
    JOBPAL_RESUME_PATH: resumePath,
    JOBPAL_COVER_LETTER_PATH: coverPath,
    JOBPAL_PAUSED_FILE: pausedFile,
    JOBPAL_HUMAN_ACTION_DONE_FILE: doneFile,
    DISPLAY: ":99",
  };

  console.log(`[runner] Starting Playwright for app ${appId}`);
  const proc = spawnPlaywright(env);
  const exitPromise = trackProc(proc);

  // Race: Playwright exits normally OR writes the paused-file (CAPTCHA handoff)
  let winner;
  try {
    winner = await Promise.race([
      exitPromise.then(() => "exited"),
      waitForFile(pausedFile, RUN_TIMEOUT_MS).then((found) => (found ? "paused" : "timeout")),
    ]);
  } catch (e) {
    winner = "exited";
  }

  if (winner === "paused") {
    const vncUrl = buildVncUrl();
    console.log(`[runner] App ${appId} paused for human action. VNC: ${vncUrl}`);

    // Store session so /resume can signal and await it.
    // Also store userId so the auto-exit handler can call pushToSupabase.
    const sessionUserId = String(payload?.user_id ?? "");
    activeSessions.set(appId, { proc, doneFile, exitPromise, tempDir, outputDir, cleanupPaths, runId });

    // Auto-exit handler: if Playwright exits without /resume ever being called
    // (e.g. spec auto-detected submission and exited on its own), push the final
    // state to Supabase here.  If /resume was called first, handleResume() already
    // deleted the session from activeSessions, so wasActive will be false and we
    // skip the duplicate push.
    exitPromise.then(async (procResult) => {
      const wasActive = activeSessions.delete(appId); // true only if /resume wasn't called
      if (wasActive) {
        console.log(`[session] Playwright exited for ${appId} without /resume — pushing final state.`);
        try {
          const { body } = await readArtifacts(outputDir, runId, procResult);
          console.log(`[session] Auto-exit status for ${appId}: ${body.status}`);
          await pushToSupabase(appId, sessionUserId, body);
        } catch (e) {
          console.error(`[session] Auto-exit pushToSupabase failed for ${appId}:`, e.message);
        }
      }
      for (const f of cleanupPaths) fs.rm(f, { force: true }).catch(() => {});
      fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    });

    return {
      httpStatus: 200,
      body: { status: "waiting_for_human_action", hard_blocker: false, vnc_url: vncUrl },
    };
  }

  if (winner === "timeout") {
    proc.kill("SIGTERM");
    for (const f of cleanupPaths) await fs.rm(f, { force: true }).catch(() => {});
    return {
      httpStatus: 504,
      body: { status: "failed", hard_blocker: true, error: `Runner timed out after ${RUN_TIMEOUT_MS}ms` },
    };
  }

  // Playwright exited on its own
  const procResult = await exitPromise;
  for (const f of cleanupPaths) await fs.rm(f, { force: true }).catch(() => {});

  const result = await readArtifacts(outputDir, runId, procResult);
  return result;
}

// ─── Supabase REST writer (used post-resume, out-of-band) ────────────────────

async function pushToSupabase(appId, userId, runnerBody) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.warn("[supabase] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY — skipping DB update after resume");
    return;
  }

  const returnedStatus = typeof runnerBody.status === "string" ? runnerBody.status : "";
  const isSubmitted = returnedStatus === "submitted";
  const queueState =
    isSubmitted
      ? "waiting_for_review"  // row will be hidden anyway by submission_status filter
      : returnedStatus === "waiting_for_human_action" || returnedStatus === "blocked"
        ? "waiting_for_human_action"
        : returnedStatus === "failed"
          ? "failed"
          : "waiting_for_review";

  const now = new Date().toISOString();
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Prefer: "return=minimal",
  };

  // 1. Update applications row
  const patchBody = {
    automation_queue_state: queueState,
    automation_last_run_at: now,
    automation_last_outcome: isSubmitted ? "submitted" : queueState,
    automation_last_error: runnerBody.message ?? runnerBody.error ?? null,
    automation_last_context: {
      queue_state: queueState,
      failure_reason: runnerBody.message ?? runnerBody.error ?? null,
      context: { resumed: true, queue_handoff: true, queue_run_at: now },
    },
    // Clear the live URL now that the session is done
    automation_live_url: null,
    // Mark as submitted when the spec auto-detected the confirmation page
    ...(isSubmitted ? { submission_status: "submitted", submitted_at: now } : {}),
  };

  try {
    const patchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/applications?id=eq.${encodeURIComponent(appId)}&user_id=eq.${encodeURIComponent(userId)}&submission_status=neq.submitted`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify(patchBody),
      },
    );
    if (!patchRes.ok) {
      console.error(`[supabase] PATCH applications failed: ${patchRes.status} ${await patchRes.text()}`);
    } else {
      console.log(`[supabase] Updated app ${appId} → ${queueState}`);
    }
  } catch (e) {
    console.error("[supabase] PATCH applications error:", e.message);
  }

  // 2. Insert automation_status event
  try {
    const description =
      isSubmitted
        ? "Application submitted by user via live browser (auto-detected)"
        : queueState === "waiting_for_review"
          ? "Autofill completed after human action; waiting for review"
          : queueState === "waiting_for_human_action"
            ? "Resume completed but another human action is still required"
            : "Run failed after resume";
    const evtRes = await fetch(`${SUPABASE_URL}/rest/v1/application_events`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        application_id: appId,
        user_id: userId,
        event_type: "automation_status",
        description,
        metadata: {
          queue_state: queueState,
          failure_reason: runnerBody.message ?? runnerBody.error ?? null,
          context: { resumed: true, queue_handoff: true, queue_run_at: now },
        },
      }),
    });
    if (!evtRes.ok) {
      console.error(`[supabase] POST application_events failed: ${evtRes.status} ${await evtRes.text()}`);
    }
  } catch (e) {
    console.error("[supabase] POST application_events error:", e.message);
  }
}

// ─── Resume handler (fire-and-forget) ────────────────────────────────────────

async function handleResume(appId, userId) {
  const session = activeSessions.get(appId);
  if (!session) {
    console.warn(`[resume] No active session for ${appId}`);
    return {
      httpStatus: 404,
      body: { error: `No active session for application ${appId}. It may have already completed.` },
    };
  }

  console.log(`[resume] Writing done-signal for ${appId}`);
  try {
    await fs.writeFile(session.doneFile, "done");
  } catch (e) {
    return { httpStatus: 500, body: { error: `Could not write done signal: ${e.message}` } };
  }

  // Fire-and-forget: let Playwright finish in the background and write the final
  // state to Supabase directly. The caller (Edge Function) gets a 202 immediately
  // and does not need to wait — Supabase Edge Function timeouts are avoided.
  const bgUserId = userId;
  (async () => {
    try {
      console.log(`[resume] Awaiting Playwright completion for ${appId} in background ...`);
      const procResult = await session.exitPromise;
      console.log(`[resume] Playwright finished for ${appId} with code ${procResult.code}`);
      activeSessions.delete(appId);

      const { httpStatus, body } = await readArtifacts(session.outputDir, session.runId, procResult);
      console.log(`[resume] Artifacts read for ${appId}: status=${body.status}`);

      await pushToSupabase(appId, bgUserId, body);
    } catch (e) {
      console.error(`[resume] Background completion failed for ${appId}:`, e.message);
    } finally {
      for (const f of session.cleanupPaths) fs.rm(f, { force: true }).catch(() => {});
      fs.rm(session.tempDir, { recursive: true, force: true }).catch(() => {});
    }
  })();

  // Return immediately so the Edge Function is not held open
  return { httpStatus: 202, body: { status: "human_action_completed", message: "Resume signal sent; automation continuing in background." } };
}

// ─── noVNC static file serving ────────────────────────────────────────────────

async function serveNoVnc(req, res) {
  const rawPath = req.url.replace(/^\/vnc/, "").split("?")[0] || "/";
  const safePath = path.normalize(rawPath).replace(/^(\.\.[/\\])+/, "");
  const candidates = [
    path.join(NOVNC_STATIC, safePath),
    path.join(NOVNC_STATIC, safePath, "vnc.html"),
    path.join(NOVNC_STATIC, safePath, "index.html"),
  ];

  for (const candidate of candidates) {
    if (!candidate.startsWith(NOVNC_STATIC)) continue; // path traversal guard
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) {
        const ext = path.extname(candidate).toLowerCase();
        res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
        createReadStream(candidate).pipe(res);
        return;
      }
    } catch {
      /* try next */
    }
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("noVNC file not found");
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  // Health check
  if (req.method === "GET" && req.url === "/healthz") {
    return sendJson(res, 200, {
      ok: true,
      service: "jobpal-automation-runner",
      active_sessions: activeSessions.size,
    });
  }

  // noVNC static files
  if (req.method === "GET" && req.url?.startsWith("/vnc")) {
    return serveNoVnc(req, res);
  }

  // POST /run — start a new automation run
  if (req.method === "POST" && req.url === "/run") {
    try {
      if (shouldRejectForAuth(req)) return sendJson(res, 401, { error: "Unauthorized runner token" });

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

  // POST /resume — signal a paused Playwright to continue (fire-and-forget)
  if (req.method === "POST" && req.url === "/resume") {
    try {
      if (shouldRejectForAuth(req)) return sendJson(res, 401, { error: "Unauthorized runner token" });

      const body = await readJsonBody(req);
      const appId = typeof body.application_id === "string" ? body.application_id.trim() : "";
      const userId = typeof body.user_id === "string" ? body.user_id.trim() : "";
      if (!appId) return sendJson(res, 400, { error: "Missing application_id" });

      const result = await handleResume(appId, userId);
      return sendJson(res, result.httpStatus, result.body);
    } catch (error) {
      return sendJson(res, 500, {
        status: "failed",
        hard_blocker: false,
        error: error instanceof Error ? error.message : "Unexpected resume error",
      });
    }
  }

  return sendJson(res, 404, { error: "Not found" });
});

// ─── WebSocket proxy: /vnc-ws → websockify :6080 ─────────────────────────────

server.on("upgrade", (req, socket, head) => {
  if (!req.url?.startsWith("/vnc-ws")) {
    socket.destroy();
    return;
  }

  const target = net.connect({ port: VNC_WS_PORT, host: "localhost" }, () => {
    // Forward the original HTTP upgrade request headers verbatim
    const firstLine = `GET ${req.url} HTTP/1.1\r\n`;
    const headers =
      Object.entries(req.headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\r\n") + "\r\n\r\n";
    target.write(firstLine + headers);
    if (head?.length) target.write(head);
    target.pipe(socket);
    socket.pipe(target);
  });

  target.on("error", (e) => {
    console.error("[ws-proxy] VNC proxy error:", e.message);
    socket.destroy();
  });
  socket.on("error", () => target.destroy());
  socket.on("close", () => target.destroy());
});

// ─── Boot sequence ────────────────────────────────────────────────────────────

async function main() {
  try {
    await startXvfb();
    // Give x11vnc and websockify a moment after Xvfb
    startX11vnc();
    await sleep(1000);
    startWebsockify();
    await sleep(500);
  } catch (e) {
    console.error("[boot] Failed to start Xvfb/VNC stack:", e.message);
    console.warn("[boot] Continuing without VNC — CAPTCHA handoff will not show live browser.");
  }

  server.listen(PORT, () => {
    console.log(`JobPal runner listening on port ${PORT}`);
    console.log(`VNC URL template: ${buildVncUrl()}`);
  });
}

main().catch((e) => {
  console.error("Fatal boot error:", e);
  process.exit(1);
});
