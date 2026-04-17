import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { appendRunLog } from "./artifacts";
import type { ArtifactPaths } from "../types";

/**
 * Matches `public.applications.automation_queue_state` / `automation_last_outcome` CHECK.
 *
 * Canonical JobBot lifecycle (queue + executor + logger): autofilling → optional
 * waiting_for_human_action → waiting_for_review → ready_to_submit (user-only) → submitted | failed.
 * DB also allows `queued` (default) and `human_action_completed` (same-session resume after human steps).
 */
export type AutomationQueueState =
  | "queued"
  | "autofilling"
  | "waiting_for_human_action"
  | "human_action_completed"
  | "waiting_for_review"
  | "ready_to_submit"
  | "submitted"
  | "failed";

/** Append-only lifecycle labels (stored on events.metadata.lifecycle_phase, not queue CHECK). */
export type LifecyclePhase =
  | "autofill_started"
  | "captcha_encountered"
  | "waiting_for_human_action"
  | "human_action_completed"
  | "waiting_for_review"
  | "ready_to_submit"
  | "submitted"
  | "failed"
  | "autofill_completed"
  | "run_suspended_headless";

type LoggerConfig = {
  supabaseUrl?: string;
  serviceRoleKey?: string;
  applicationId?: string;
  userId?: string;
  runId: string;
  existingSessionId?: string;
  steelSessionId?: string;
  steelLiveUrl?: string;
};

type LogStateArgs = {
  state: AutomationQueueState;
  description: string;
  reason?: string;
  handoffReason?: string | null;
  context?: Record<string, unknown>;
  paths?: ArtifactPaths;
  finalUrl?: string;
};

type LogLifecycleArgs = {
  phase: LifecyclePhase;
  description: string;
  context?: Record<string, unknown>;
  paths?: ArtifactPaths;
  finalUrl?: string;
};

function getLoggerConfig(): LoggerConfig {
  return {
    supabaseUrl: process.env.JOBPAL_SUPABASE_URL?.trim(),
    serviceRoleKey: process.env.JOBPAL_SUPABASE_SERVICE_ROLE_KEY?.trim(),
    applicationId: process.env.JOBPAL_APPLICATION_ID?.trim(),
    userId: process.env.JOBPAL_USER_ID?.trim(),
    runId: process.env.JOBPAL_RUN_ID?.trim() || `run-${Date.now()}`,
    existingSessionId: process.env.JOBPAL_AUTOMATION_SESSION_ID?.trim(),
    steelSessionId: process.env.JOBPAL_STEEL_SESSION_ID?.trim() || undefined,
    steelLiveUrl: process.env.JOBPAL_STEEL_LIVE_URL?.trim() || undefined,
  };
}

function buildArtifactMetadata(paths: ArtifactPaths | undefined): Record<string, string> | undefined {
  if (!paths) return undefined;
  return {
    run_dir: paths.runDir,
    meta_path: paths.metaPath,
    payload_path: paths.payloadPath,
    run_log_path: paths.runLogPath,
    screenshot_before_path: paths.screenshotBeforePath,
    screenshot_after_path: paths.screenshotAfterPath,
    dom_snapshot_path: paths.domSnapshotPath,
    field_mappings_path: paths.fieldMappingsPath,
    human_handoff_path: paths.humanHandoffPath,
  };
}

function baseMetadata(
  config: LoggerConfig,
  args: { paths?: ArtifactPaths; finalUrl?: string; context?: Record<string, unknown> },
): Record<string, unknown> {
  return {
    run_id: config.runId,
    final_url: args.finalUrl ?? null,
    artifacts: buildArtifactMetadata(args.paths) ?? null,
    context: args.context ?? {},
  };
}

async function ensureSession(
  client: SupabaseClient,
  config: LoggerConfig,
  paths: ArtifactPaths | undefined,
  jobUrl: string | undefined,
): Promise<string> {
  if (!config.applicationId || !config.userId) {
    throw new Error("ensureSession requires JOBPAL_APPLICATION_ID and JOBPAL_USER_ID");
  }
  if (config.existingSessionId) {
    const { data, error } = await client
      .from("application_automation_sessions")
      .select("id")
      .eq("id", config.existingSessionId)
      .eq("application_id", config.applicationId!)
      .eq("user_id", config.userId!)
      .maybeSingle();
    if (!error && data?.id) return data.id;
  }

  const metaPaths = buildArtifactMetadata(paths);
  const { data: inserted, error: insertErr } = await client
    .from("application_automation_sessions")
    .insert({
      application_id: config.applicationId!,
      user_id: config.userId!,
      run_log: [],
      screenshot_storage_paths: metaPaths
        ? [metaPaths.screenshot_before_path, metaPaths.screenshot_after_path].filter(Boolean)
        : [],
      metadata: {
        run_id: config.runId,
        job_url: jobUrl ?? null,
        artifact_paths: metaPaths ?? {},
      },
      ...(config.steelSessionId ? { steel_session_id: config.steelSessionId } : {}),
      ...(config.steelLiveUrl ? { steel_live_url: config.steelLiveUrl } : {}),
    })
    .select("id")
    .single();
  if (insertErr) throw insertErr;

  const sid = inserted.id as string;
  const { error: appErr } = await client
    .from("applications")
    .update({ automation_active_session_id: sid })
    .eq("id", config.applicationId!);
  if (appErr) throw appErr;
  return sid;
}

async function appendSessionRunLog(
  client: SupabaseClient,
  sessionId: string,
  message: string,
  level: "info" | "warn" | "error" = "info",
): Promise<void> {
  const { data, error } = await client.from("application_automation_sessions").select("run_log").eq("id", sessionId).single();
  if (error) throw error;
  const prev = Array.isArray(data.run_log) ? (data.run_log as Record<string, unknown>[]) : [];
  const entry = { at: new Date().toISOString(), level, message };
  const { error: upErr } = await client
    .from("application_automation_sessions")
    .update({ run_log: [...prev, entry] })
    .eq("id", sessionId);
  if (upErr) throw upErr;
}

async function patchSessionForState(
  client: SupabaseClient,
  sessionId: string,
  state: AutomationQueueState,
  handoffReason: string | null | undefined,
  paths: ArtifactPaths | undefined,
): Promise<void> {
  const metaPaths = buildArtifactMetadata(paths);
  const patch: Record<string, unknown> = {};

  if (state === "waiting_for_human_action") {
    patch.handoff_required_at = new Date().toISOString();
    patch.handoff_reason = handoffReason ?? "human_handoff";
    const steelSessionId = process.env.JOBPAL_STEEL_SESSION_ID?.trim() || undefined;
    const steelLiveUrl = process.env.JOBPAL_STEEL_LIVE_URL?.trim() || undefined;
    if (steelSessionId) patch.steel_session_id = steelSessionId;
    if (steelLiveUrl) patch.steel_live_url = steelLiveUrl;
  }
  if (state === "human_action_completed") {
    patch.handoff_completed_at = new Date().toISOString();
  }
  /** Session ends only on terminal automation outcomes (not review / ready gates). */
  if (state === "failed" || state === "submitted") {
    patch.ended_at = new Date().toISOString();
  }

  if (metaPaths) {
    const { data, error } = await client
      .from("application_automation_sessions")
      .select("metadata, screenshot_storage_paths")
      .eq("id", sessionId)
      .single();
    if (error) throw error;
    const md = (data.metadata && typeof data.metadata === "object" ? data.metadata : {}) as Record<string, unknown>;
    md.artifact_paths = { ...(typeof md.artifact_paths === "object" ? md.artifact_paths : {}), ...metaPaths };
    md.last_queue_state = state;
    patch.metadata = md;

    const prevPaths = Array.isArray(data.screenshot_storage_paths)
      ? (data.screenshot_storage_paths as string[])
      : [];
    const add = [metaPaths.screenshot_before_path, metaPaths.screenshot_after_path].filter(
      (p) => p && !prevPaths.includes(p),
    );
    if (add.length) patch.screenshot_storage_paths = [...prevPaths, ...add];
  }

  if (Object.keys(patch).length === 0) return;
  const { error: upErr } = await client.from("application_automation_sessions").update(patch).eq("id", sessionId);
  if (upErr) throw upErr;
}

function submissionSyncForQueueState(state: AutomationQueueState): Record<string, unknown> | null {
  if (state === "submitted") {
    const now = new Date().toISOString();
    return { submission_status: "submitted", applied_at: now };
  }
  /** Routine queue transitions must not overwrite submission_status (e.g. user already marked submitted). */
  return null;
}

export function createOutcomeLogger(jobUrl?: string) {
  const config = getLoggerConfig();
  const enabled = Boolean(
    config.supabaseUrl && config.serviceRoleKey && config.applicationId && config.userId,
  );
  const client = enabled
    ? createClient(config.supabaseUrl!, config.serviceRoleKey!, { auth: { persistSession: false } })
    : null;

  let sessionIdPromise: Promise<string> | null = null;

  async function resolveSessionId(paths?: ArtifactPaths): Promise<string | null> {
    if (!enabled || !client) return null;
    if (!sessionIdPromise) {
      sessionIdPromise = ensureSession(client, config, paths, jobUrl);
    }
    return sessionIdPromise;
  }

  async function syncSessionArtifacts(paths: ArtifactPaths, extraPaths?: string[]): Promise<void> {
    if (!enabled || !client) return;
    const sessionId = await resolveSessionId(paths);
    if (!sessionId) return;

    const metaPaths = buildArtifactMetadata(paths);
    if (!metaPaths) return;

    const { data, error } = await client
      .from("application_automation_sessions")
      .select("metadata, screenshot_storage_paths")
      .eq("id", sessionId)
      .single();
    if (error) throw error;

    const md = (data.metadata && typeof data.metadata === "object" ? data.metadata : {}) as Record<string, unknown>;
    const prevArtifactPaths =
      md.artifact_paths && typeof md.artifact_paths === "object" ? (md.artifact_paths as Record<string, string>) : {};
    md.artifact_paths = { ...prevArtifactPaths, ...metaPaths };
    md.last_artifact_sync_at = new Date().toISOString();

    const imageLike = (p: string) => /\.(png|jpe?g|webp)$/i.test(p);
    const fromMeta = Object.values(metaPaths).filter((p) => typeof p === "string" && imageLike(p)) as string[];
    const extras = (extraPaths ?? []).filter((p) => p && imageLike(p));
    const prevPaths = Array.isArray(data.screenshot_storage_paths)
      ? (data.screenshot_storage_paths as string[])
      : [];
    const add = [...fromMeta, ...extras].filter((p) => p && !prevPaths.includes(p));

    const patch: Record<string, unknown> = { metadata: md };
    if (add.length) patch.screenshot_storage_paths = [...prevPaths, ...add];

    const { error: upErr } = await client.from("application_automation_sessions").update(patch).eq("id", sessionId);
    if (upErr) throw upErr;
  }

  async function logLifecycle(args: LogLifecycleArgs): Promise<void> {
    if (!enabled || !client) return;
    const sessionId = await resolveSessionId(args.paths);
    if (!sessionId) return;

    const metadata = {
      ...baseMetadata(config, args),
      lifecycle_phase: args.phase,
      session_id: sessionId,
      pause:
        args.phase === "captcha_encountered" ||
        args.phase === "run_suspended_headless" ||
        args.phase === "waiting_for_human_action",
    };

    const eventInsert = await client.from("application_events").insert({
      application_id: config.applicationId!,
      user_id: config.userId!,
      event_type: "automation_status",
      description: args.description,
      metadata,
    });
    if (eventInsert.error) throw eventInsert.error;

    await appendSessionRunLog(client, sessionId, `[${args.phase}] ${args.description}`);
  }

  async function logState(args: LogStateArgs): Promise<void> {
    if (!enabled || !client) return;
    const sessionId = await resolveSessionId(args.paths);
    if (!sessionId) return;

    const isFailure = args.state === "failed";
    const isWaitingForHuman = args.state === "waiting_for_human_action";
    const metadata = {
      ...baseMetadata(config, args),
      queue_state: args.state,
      session_id: sessionId,
      handoff_reason: args.handoffReason ?? null,
      failure_reason: isFailure ? (args.reason ?? null) : null,
      pause: isWaitingForHuman,
      ...(isWaitingForHuman
        ? {
            steel_live_url: config.steelLiveUrl ?? null,
            steel_session_id: config.steelSessionId ?? null,
          }
        : {}),
    };

    const eventInsert = await client.from("application_events").insert({
      application_id: config.applicationId!,
      user_id: config.userId!,
      event_type: "automation_status",
      description: args.description,
      metadata,
    });
    if (eventInsert.error) throw eventInsert.error;

    const now = new Date().toISOString();
    const submissionPatch = submissionSyncForQueueState(args.state);

    const appUpdate: Record<string, unknown> = {
      automation_queue_state: args.state,
      automation_last_run_at: now,
      automation_last_outcome: args.state,
      automation_last_error: isFailure ? (args.reason ?? args.description) : null,
      automation_last_context: metadata,
      ...(submissionPatch ?? {}),
      ...(config.steelLiveUrl && isWaitingForHuman
        ? { automation_live_url: config.steelLiveUrl }
        : {}),
    };

    const appRes = await client.from("applications").update(appUpdate).eq("id", config.applicationId!);
    if (appRes.error) throw appRes.error;

    await patchSessionForState(client, sessionId, args.state, args.handoffReason ?? null, args.paths);
    await appendSessionRunLog(client, sessionId, `[${args.state}] ${args.description}`);
  }

  async function appendLocalAndSession(paths: ArtifactPaths, message: string): Promise<void> {
    await appendRunLog(paths, message);
    if (!enabled || !client) return;
    const sid = await resolveSessionId(paths);
    if (sid) await appendSessionRunLog(client, sid, message);
  }

  return {
    enabled,
    runId: config.runId,
    logLifecycle,
    logState,
    appendLocalAndSession,
    resolveSessionId,
    syncSessionArtifacts,
  };
}
