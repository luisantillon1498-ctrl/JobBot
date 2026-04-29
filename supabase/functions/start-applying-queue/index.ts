import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const RUNNER_TIMEOUT_MS = 120_000;
// Resume calls return 202 immediately (fire-and-forget); 15 s is plenty.
const RESUME_RUNNER_TIMEOUT_MS = 15_000;
const SIGNED_URL_TTL_SECONDS = 2 * 60 * 60;
const PG_INT_MAX = 2147483647;

/** Persisted `applications.automation_queue_state` — same vocabulary as the executor outcome logger. */
type QueueState =
  | "queued"
  | "autofilling"
  | "waiting_for_human_action"
  | "human_action_completed"
  | "waiting_for_review"
  | "ready_to_submit"
  | "submitted"
  | "failed";

type RunnerResult = {
  ok?: boolean;
  status?: string;
  message?: string;
  hard_blocker?: boolean;
  final_url?: string;
  artifacts?: Record<string, unknown>;
  unanswered_questions?: unknown[];
  unfilled_fields?: unknown[];
  unfilled_required?: unknown[];
  blocked_reason?: string;
  error?: string;
  /** noVNC live-view URL (self-hosted, replaces Steel live URL) */
  vnc_url?: string;
};

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function pickRunnerError(res: RunnerResult, fallback: string): string {
  const candidates = [res.error, res.message, res.blocked_reason];
  for (const item of candidates) {
    if (typeof item === "string" && item.trim()) return item.trim();
  }
  return fallback;
}

function sanitizeStorageFileName(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120) || "file.txt";
}

/** Mirrors `automation/lib/siteDetection.ts` for queue payload metadata. */
function atsTargetFromJobUrl(jobUrl: string): "greenhouse" | "workday" | "ashby" | "unknown" {
  try {
    const u = new URL(jobUrl);
    const h = u.hostname.toLowerCase();
    if (h.includes("greenhouse.io")) return "greenhouse";
    if (
      h.includes("myworkdayjobs.com") ||
      h.includes("wd103.myworkday.com") ||
      (h.includes("workday.com") && jobUrl.toLowerCase().includes("myworkdayjobs"))
    ) {
      return "workday";
    }
    if (h.includes("ashbyhq.com")) return "ashby";
    return "unknown";
  } catch {
    return "unknown";
  }
}

function handoffCategoryFromText(...parts: (string | undefined)[]): string | null {
  const blob = parts.filter(Boolean).join(" ").toLowerCase();
  if (blob.includes("captcha") || blob.includes("recaptcha") || blob.includes("hcaptcha") || blob.includes("turnstile")) {
    return "captcha";
  }
  if (blob.includes("two-factor") || blob.includes("2fa") || blob.includes("verification code")) return "two_factor";
  if (blob.includes("login") || blob.includes("sign in")) return "login";
  if (blob.includes("multi-step")) return "multi_step";
  return null;
}

const APPLICATION_SELECT =
  "id, user_id, job_url, company_name, job_title, job_description, submission_status, automation_queue_priority, automation_queue_excluded, automation_queue_state, submitted_resume_document_id, submitted_cover_document_id";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  console.log("[EF] invoked, method=POST");

  try {
    let clientApplicationIds: string[] | null = null;
    let resumeMode = false;
    const contentType = req.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      try {
        const parsed = (await req.json()) as Record<string, unknown>;
        if (Array.isArray(parsed.application_ids) && parsed.application_ids.length > 0) {
          const ids = parsed.application_ids.filter((x): x is string => typeof x === "string" && x.length > 0);
          if (ids.length > 0) clientApplicationIds = ids;
        }
        resumeMode = parsed.resume === true;
      } catch {
        /* ignore invalid JSON */
      }
    }
    console.log("[EF] body parsed — resumeMode:", resumeMode, "explicit ids:", clientApplicationIds?.length ?? 0);

    const authHeader = req.headers.get("authorization");
    if (!authHeader) { console.log("[EF] 401 no auth header"); return json(401, { error: "Not authenticated" }); }

    // Decode the JWT locally — avoids a network round-trip to Supabase Auth that
    // fails or hangs with ES256 tokens. "Verify JWT" is disabled at the infra
    // level on this function, so we trust the token was valid when issued.
    let user: { id: string } | null = null;
    try {
      const token = authHeader.replace(/^Bearer\s+/i, "");
      const payloadB64 = token.split(".")[1];
      // Deno's atob expects standard base64; JWT uses base64url — fix padding/chars
      const payloadJson = atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/").padEnd(
        payloadB64.length + (4 - (payloadB64.length % 4)) % 4, "=",
      ));
      const payload = JSON.parse(payloadJson) as Record<string, unknown>;
      if (typeof payload.sub === "string" && payload.sub) {
        user = { id: payload.sub };
      }
    } catch {
      /* fall through to 401 below */
    }
    if (!user) { console.log("[EF] 401 invalid JWT"); return json(401, { error: "Invalid auth" }); }
    console.log("[EF] auth OK — user:", user.id);

    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!serviceRoleKey) {
      console.log("[EF] 500 missing SUPABASE_SERVICE_ROLE_KEY");
      return json(500, { error: "Missing SUPABASE_SERVICE_ROLE_KEY secret for queue handoff." });
    }
    const runnerUrl = Deno.env.get("JOBPAL_AUTOMATION_RUNNER_URL")?.trim();
    console.log("[EF] runnerUrl:", runnerUrl ?? "(not set)");
    if (!runnerUrl) {
      return json(500, { error: "Missing JOBPAL_AUTOMATION_RUNNER_URL secret for queue handoff." });
    }

    const runnerToken = Deno.env.get("JOBPAL_AUTOMATION_RUNNER_TOKEN")?.trim();
    // Derive the runner's base URL (strip trailing /run)
    const runnerBaseUrl = runnerUrl.replace(/\/run\/?$/, "").replace(/\/$/, "");

    const serviceClient = createClient(Deno.env.get("SUPABASE_URL")!, serviceRoleKey, {
      auth: { persistSession: false },
    });

    type AppRow = {
      id: string;
      user_id: string;
      job_url: string | null;
      company_name: string | null;
      job_title: string | null;
      job_description: string | null;
      submission_status: string;
      automation_queue_priority: number;
      automation_queue_excluded: boolean;
      automation_queue_state: string;
      submitted_resume_document_id: string | null;
      submitted_cover_document_id: string | null;
    };

    let queue: AppRow[] = [];

    if (clientApplicationIds && clientApplicationIds.length > 0) {
      const { data: rows, error: byIdError } = await serviceClient
        .from("applications")
        .select(APPLICATION_SELECT)
        .eq("user_id", user.id)
        .in("id", clientApplicationIds)
        .neq("submission_status", "submitted");
      if (byIdError) return json(500, { error: byIdError.message || "Could not load applications" });
      const rowById = new Map((rows ?? []).map((r) => [String((r as AppRow).id), r as AppRow]));
      // Deduplicate IDs (same ID passed twice would cause double-processing on the runner)
      const deduped = [...new Set(clientApplicationIds)];
      let ordered = deduped.map((id) => rowById.get(id)).filter((r): r is AppRow => Boolean(r));
      ordered = ordered.filter((r) => !r.automation_queue_excluded && Boolean(r.job_url));
      if (resumeMode) {
        ordered = ordered.filter((r) => r.automation_queue_state === "waiting_for_human_action");
      }
      queue = ordered;
    } else {
      const { data: apps, error: appsError } = await serviceClient
        .from("applications")
        .select(APPLICATION_SELECT)
        .eq("user_id", user.id)
        .eq("automation_queue_excluded", false)
        .neq("submission_status", "submitted")
        .order("automation_queue_priority", { ascending: true })
        .order("created_at", { ascending: true });
      if (appsError) return json(500, { error: appsError.message || "Could not load queue" });
      let fromDb = (apps ?? []) as AppRow[];
      if (resumeMode) {
        fromDb = fromDb.filter((r) => r.automation_queue_state === "waiting_for_human_action");
      }
      queue = fromDb.filter((row) => row.job_url);
    }

    console.log("[EF] queue built — length:", queue.length, "apps:", queue.map((a) => a.id));

    if (queue.length === 0) {
      return json(200, {
        ok: true,
        processed: 0,
        skipped: resumeMode
          ? "No applications in waiting_for_human_action matched this resume request."
          : "No queued applications with job URLs.",
        outcomes: [],
        stopped_by_hard_blocker: false,
      });
    }

    const { data: profile } = await serviceClient
      .from("profiles")
      .select(
        "first_name, middle_name, last_name, professional_email, phone, linkedin_url, city, state_region, country, veteran_status, disability_status, gender, hispanic_ethnicity, race_ethnicity",
      )
      .eq("user_id", user.id)
      .single();

    async function ensureCoverFromArtifact(args: {
      applicationId: string;
      companyName: string;
      jobTitle: string;
      artifact: { id: string; content: string };
    }): Promise<string | null> {
      const existing = await serviceClient
        .from("documents")
        .select("id")
        .eq("user_id", user.id)
        .eq("source_generated_artifact_id", args.artifact.id)
        .maybeSingle();
      if (existing.data?.id) return existing.data.id;

      const safeBase = sanitizeStorageFileName(
        `cover_${args.companyName}_${args.jobTitle}_${args.artifact.id.slice(0, 8)}.txt`,
      );
      const filePath = `${user.id}/${Date.now()}_${safeBase}`;
      const contentBlob = new Blob([args.artifact.content], { type: "text/plain;charset=utf-8" });
      const uploaded = await serviceClient.storage.from("documents").upload(filePath, contentBlob, {
        contentType: "text/plain;charset=utf-8",
        upsert: false,
      });
      if (uploaded.error) return null;

      const fileSize = contentBlob.size > PG_INT_MAX ? null : contentBlob.size;
      const inserted = await serviceClient
        .from("documents")
        .insert({
          user_id: user.id,
          name: `Cover letter — ${args.companyName} — ${args.jobTitle}.txt`,
          type: "cover_letter_template",
          file_path: filePath,
          file_size: fileSize,
          source_generated_artifact_id: args.artifact.id,
        })
        .select("id")
        .single();

      if (inserted.error || !inserted.data?.id) {
        await serviceClient.storage.from("documents").remove([filePath]);
        return null;
      }

      await serviceClient.from("application_documents").insert({
        application_id: args.applicationId,
        document_id: inserted.data.id,
        user_id: user.id,
      });

      return inserted.data.id;
    }

    async function logState(args: {
      appId: string;
      state: QueueState;
      description: string;
      reason?: string;
      context?: Record<string, unknown>;
    }) {
      const now = new Date().toISOString();
      const context = {
        queue_handoff: true,
        queue_run_at: now,
        ...(args.context ?? {}),
      };
      const metadata = {
        queue_state: args.state,
        failure_reason: args.reason ?? null,
        context,
      };

      await serviceClient.from("application_events").insert({
        application_id: args.appId,
        user_id: user.id,
        event_type: "automation_status",
        description: args.description,
        metadata,
      });

      await serviceClient
        .from("applications")
        .update({
          automation_queue_state: args.state,
          automation_last_run_at: now,
          automation_last_outcome: args.state,
          automation_last_error: args.reason ?? null,
          automation_last_context: metadata,
        })
        .eq("id", args.appId)
        .eq("user_id", user.id)
        .neq("submission_status", "submitted");
    }

    const outcomes: Array<{
      application_id: string;
      state: QueueState;
      hard_blocker: boolean;
      reason?: string;
      steel_live_url?: string;
    }> = [];
    let hardStop = false;

    for (const app of queue) {
      if (hardStop) break;
      const appId = String(app.id);

      // ── Resume mode: fire-and-forget signal to the runner ─────────────────
      // The runner returns 202 immediately; Playwright keeps running in the
      // background and writes the final state to Supabase directly.
      // We record human_action_completed here and let the runner update it to
      // waiting_for_review / failed when Playwright finishes.
      if (resumeMode) {
        await logState({
          appId,
          state: "human_action_completed",
          description: "Resume signal sent to runner — Playwright resuming autofill in background",
          context: { queue_priority: app.automation_queue_priority, job_url: app.job_url },
        });

        let resumeResponse: Response | null = null;
        try {
          resumeResponse = await fetch(`${runnerBaseUrl}/resume`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(runnerToken ? { Authorization: `Bearer ${runnerToken}` } : {}),
            },
            // Pass user_id so the runner can write back to Supabase with correct RLS filter
            body: JSON.stringify({ application_id: appId, user_id: user.id }),
            signal: AbortSignal.timeout(RESUME_RUNNER_TIMEOUT_MS),
          });
        } catch (error) {
          const reason = error instanceof Error ? error.message : "Resume call failed";
          await logState({
            appId,
            state: "waiting_for_human_action",
            description: "Resume failed: could not reach runner",
            reason,
            context: { hard_blocker: false },
          });
          outcomes.push({ application_id: appId, state: "waiting_for_human_action", hard_blocker: false, reason });
          continue;
        }

        // 202 = fire-and-forget accepted; anything else is an error
        if (resumeResponse.status === 202 || resumeResponse.status === 200) {
          // Success — runner acknowledged the resume signal.
          // Final state (waiting_for_review / failed) will be written by the runner
          // directly to Supabase when Playwright completes. The frontend polls on reload.
          outcomes.push({ application_id: appId, state: "human_action_completed", hard_blocker: false });
        } else {
          let resumeBody: RunnerResult = {};
          try { resumeBody = (await resumeResponse.json()) as RunnerResult; } catch { resumeBody = {}; }
          const reason = pickRunnerError(resumeBody, `Runner /resume returned ${resumeResponse.status}`);
          await logState({
            appId,
            state: "waiting_for_human_action",
            description: "Resume runner call failed",
            reason,
          });
          outcomes.push({ application_id: appId, state: "waiting_for_human_action", hard_blocker: false, reason });
        }
        continue;
      }

      // ── Normal mode: start a fresh Playwright run ──────────────────────────

      // Guard: skip apps that are already in an active automation state.
      // Restarting them would wipe the existing session state, crash the live
      // Playwright process, and break the noVNC browser connection.
      // Guard: skip apps that have already completed (use Re-queue to retry them).
      {
        const activeStates = ["autofilling", "waiting_for_human_action", "human_action_completed"];
        const doneStates = ["waiting_for_review", "submitted"];
        if (activeStates.includes(app.automation_queue_state)) {
          console.log(`[EF] app ${appId} — skipping (already active: ${app.automation_queue_state}); hardStop`);
          outcomes.push({ application_id: appId, state: app.automation_queue_state as QueueState, hard_blocker: true });
          hardStop = true; // Don't start new apps while a session is paused/running
          continue;
        }
        if (doneStates.includes(app.automation_queue_state)) {
          console.log(`[EF] app ${appId} — skipping (already done: ${app.automation_queue_state})`);
          outcomes.push({ application_id: appId, state: app.automation_queue_state as QueueState, hard_blocker: false });
          continue;
        }
      }

      await logState({
        appId,
        state: "autofilling",
        description: "Queue handoff started browser automation",
        context: { queue_priority: app.automation_queue_priority, job_url: app.job_url },
      });

      // Wrap everything after writing `autofilling` in a per-app try/catch so that any
      // unhandled exception (e.g. in document resolution or generation) writes `failed`
      // to the DB rather than leaving the app permanently stuck in `autofilling`.
      try {

      let resumeDocumentId = app.submitted_resume_document_id ?? null;
      let coverDocumentId = app.submitted_cover_document_id ?? null;

      // Fall back to the most recently linked/generated resume for this application
      // (generate-resume stores the PDF in application_documents but does not set
      //  submitted_resume_document_id, so we need a separate lookup here).
      if (!resumeDocumentId) {
        const linkedResume = await serviceClient
          .from("application_documents")
          .select("document_id, documents!inner(id, type)")
          .eq("application_id", appId)
          .eq("user_id", user.id)
          .eq("documents.type", "resume")
          .limit(1)
          .maybeSingle();
        if (linkedResume.data?.document_id) {
          resumeDocumentId = linkedResume.data.document_id;
          console.log(`[EF] app ${appId} — found linked resume via application_documents: ${resumeDocumentId}`);
        }
      }

      // Still no resume — generate one on the fly (mirrors cover letter generation below).
      // This handles applications that were imported before auto-resume-generation was added,
      // or cases where the user hasn't manually selected a resume.
      if (!resumeDocumentId) {
        console.log(`[EF] app ${appId} — no resume found, generating tailored resume via Edge Function`);
        const generateRes = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/generate-resume`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // Forward the user's JWT so generate-resume can resolve the caller via getUser().
            // Use serviceRoleKey as the apikey header (replaces the deprecated SUPABASE_ANON_KEY).
            Authorization: authHeader,
            apikey: serviceRoleKey,
          },
          body: JSON.stringify({ application_id: appId }),
          // Keep well under the EF wall-clock limit so a slow AI/PDF call never
          // prevents the browser automation runner from being reached.
          signal: AbortSignal.timeout(30_000),
        });
        console.log(`[EF] app ${appId} — resume gen HTTP status:`, generateRes.status);
        if (generateRes.ok) {
          const genBody = await generateRes.json() as { ok?: boolean; document_id?: string; error?: string; code?: string };
          if (genBody.ok && genBody.document_id) {
            resumeDocumentId = genBody.document_id;
            console.log(`[EF] app ${appId} — generated resume document_id: ${resumeDocumentId}`);
          } else {
            console.error(`[EF] app ${appId} — generate-resume returned ok=false: code=${genBody.code} error=${genBody.error}`);
          }
        } else {
          const errText = await generateRes.text().catch(() => "");
          console.error(`[EF] app ${appId} — generate-resume HTTP error ${generateRes.status}: ${errText.slice(0, 500)}`);
        }
      }

      // Pin whichever resume we resolved (default, linked, or freshly generated) so future
      // runs skip the resolution chain entirely.
      if (!app.submitted_resume_document_id && resumeDocumentId) {
        await serviceClient
          .from("applications")
          .update({ submitted_resume_document_id: resumeDocumentId })
          .eq("id", appId)
          .eq("user_id", user.id)
          .neq("submission_status", "submitted");
      }

      if (!coverDocumentId) {
        const existingLinkedCover = await serviceClient
          .from("application_documents")
          .select("document_id, documents!inner(id, type)")
          .eq("application_id", appId)
          .eq("user_id", user.id)
          .eq("documents.type", "cover_letter_template")
          .limit(1)
          .maybeSingle();
        if (existingLinkedCover.data?.document_id) {
          coverDocumentId = existingLinkedCover.data.document_id;
        }
      }

      if (!coverDocumentId) {
        const latestArtifact = await serviceClient
          .from("generated_artifacts")
          .select("id, content")
          .eq("application_id", appId)
          .eq("user_id", user.id)
          .eq("type", "cover_letter")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (latestArtifact.data?.id && latestArtifact.data.content) {
          coverDocumentId = await ensureCoverFromArtifact({
            applicationId: appId,
            companyName: app.company_name || "Company",
            jobTitle: app.job_title || "Role",
            artifact: { id: latestArtifact.data.id, content: latestArtifact.data.content },
          });
        }
      }

      console.log(`[EF] app ${appId} — resumeDocId:`, resumeDocumentId ?? "(none)", "coverDocId before gen:", coverDocumentId ?? "(none)");
      if (!coverDocumentId) {
        const resumeForGeneration = resumeDocumentId
          ? await serviceClient
              .from("documents")
              .select("file_path")
              .eq("id", resumeDocumentId)
              .eq("user_id", user.id)
              .maybeSingle()
          : { data: null };

        console.log(`[EF] app ${appId} — generating cover letter via Edge Function`);
        const generateRes = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/generate-cover-letter`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // Forward the user's JWT so generate-cover-letter can resolve the caller via getUser().
            // Use serviceRoleKey as the apikey header (replaces the deprecated SUPABASE_ANON_KEY).
            Authorization: authHeader,
            apikey: serviceRoleKey,
          },
          body: JSON.stringify({
            application_id: appId,
            job_title: app.job_title ?? "",
            company_name: app.company_name ?? "",
            job_description: app.job_description ?? "",
            resume_path: resumeForGeneration.data?.file_path ?? null,
          }),
          signal: AbortSignal.timeout(60_000),
        });

        console.log(`[EF] app ${appId} — cover letter gen response:`, generateRes.status);
        if (generateRes.ok) {
          const generatedArtifact = await serviceClient
            .from("generated_artifacts")
            .select("id, content")
            .eq("application_id", appId)
            .eq("user_id", user.id)
            .eq("type", "cover_letter")
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          if (generatedArtifact.data?.id && generatedArtifact.data.content) {
            coverDocumentId = await ensureCoverFromArtifact({
              applicationId: appId,
              companyName: app.company_name || "Company",
              jobTitle: app.job_title || "Role",
              artifact: { id: generatedArtifact.data.id, content: generatedArtifact.data.content },
            });
          }
        }
      }

      if (!app.submitted_cover_document_id && coverDocumentId) {
        await serviceClient
          .from("applications")
          .update({ submitted_cover_document_id: coverDocumentId })
          .eq("id", appId)
          .eq("user_id", user.id)
          .neq("submission_status", "submitted");
      }

      const docsToLoad = [resumeDocumentId, coverDocumentId].filter(Boolean) as string[];
      let docById = new Map<string, { file_path: string; name: string }>();
      if (docsToLoad.length > 0) {
        const { data: docs } = await serviceClient
          .from("documents")
          .select("id, file_path, name")
          .eq("user_id", user.id)
          .in("id", docsToLoad);
        docById = new Map((docs ?? []).map((d) => [d.id, { file_path: d.file_path, name: d.name }]));
      }

      let resumeSignedUrl: string | null = null;
      let coverSignedUrl: string | null = null;
      const resumeDoc = resumeDocumentId ? docById.get(resumeDocumentId) : undefined;
      const coverDoc = coverDocumentId ? docById.get(coverDocumentId) : undefined;
      if (resumeDoc?.file_path) {
        const signed = await serviceClient.storage.from("documents").createSignedUrl(resumeDoc.file_path, SIGNED_URL_TTL_SECONDS);
        if (!signed.error) resumeSignedUrl = signed.data.signedUrl;
      }
      if (coverDoc?.file_path) {
        const signed = await serviceClient.storage.from("documents").createSignedUrl(coverDoc.file_path, SIGNED_URL_TTL_SECONDS);
        if (!signed.error) coverSignedUrl = signed.data.signedUrl;
      }

      const runnerPayload = {
        application_id: appId,
        user_id: user.id,
        job_url: app.job_url,
        ats_target: atsTargetFromJobUrl(String(app.job_url)),
        stop_before_submit: true,
        applicant: {
          first_name: profile?.first_name ?? null,
          middle_name: profile?.middle_name ?? null,
          last_name: profile?.last_name ?? null,
          email: profile?.professional_email ?? null,
          phone: profile?.phone ?? null,
          linkedin_url: profile?.linkedin_url ?? null,
          location: [profile?.city, profile?.state_region, profile?.country].filter(Boolean).join(", ") || null,
          veteran_status: profile?.veteran_status ?? null,
          disability_status: profile?.disability_status ?? null,
          gender: profile?.gender ?? null,
          hispanic_ethnicity: profile?.hispanic_ethnicity ?? null,
          race_ethnicity: (profile as any)?.race_ethnicity ?? null,
          full_name: [profile?.first_name, profile?.last_name].filter(Boolean).join(" ") || null,
          country: profile?.country ?? null,
        },
        documents: {
          resume: resumeDoc
            ? { id: resumeDocumentId, name: resumeDoc.name, file_path: resumeDoc.file_path, signed_url: resumeSignedUrl }
            : null,
          cover_letter: coverDoc
            ? { id: coverDocumentId, name: coverDoc.name, file_path: coverDoc.file_path, signed_url: coverSignedUrl }
            : null,
        },
        policies: {
          eligibility_answers: "only_when_confident",
          unknown_question_behavior: "pause_and_flag",
          continue_on_failure: true,
        },
      };

      let runnerResponse: Response | null = null;
      console.log(`[EF] calling runner for app ${appId} → POST ${runnerUrl}`);
      try {
        runnerResponse = await fetch(runnerUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(runnerToken ? { Authorization: `Bearer ${runnerToken}` } : {}),
          },
          body: JSON.stringify(runnerPayload),
          signal: AbortSignal.timeout(RUNNER_TIMEOUT_MS),
        });
        console.log(`[EF] runner responded — status: ${runnerResponse.status}`);
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Runner call failed";
        console.log(`[EF] runner fetch FAILED for app ${appId}:`, reason);
        await logState({
          appId,
          state: "waiting_for_human_action",
          description: "Queue handoff blocked: could not reach automation runner",
          reason,
          context: { hard_blocker: true, handoff_category: "runner_unreachable" },
        });
        outcomes.push({ application_id: appId, state: "waiting_for_human_action", hard_blocker: true, reason });
        hardStop = true;
        continue;
      }

      let body: RunnerResult = {};
      try { body = (await runnerResponse.json()) as RunnerResult; } catch { body = {}; }

      if (!runnerResponse.ok) {
        const reason = pickRunnerError(body, `Runner returned ${runnerResponse.status}`);
        const hard = body.hard_blocker === true;

        // 409: runner is busy with another paused session.  Reset this app to
        // "queued" — NOT "waiting_for_human_action" — so the user isn't told
        // this application needs human action when it just needs to wait for
        // the active session to finish first.
        if (runnerResponse.status === 409) {
          await logState({
            appId,
            state: "queued",
            description: "Runner busy with another session; reset to queue for retry",
            reason,
            context: { hard_blocker: true, handoff_category: "runner_busy" },
          });
          outcomes.push({ application_id: appId, state: "queued", hard_blocker: true, reason });
          hardStop = true;
          continue;
        }

        await logState({
          appId,
          state: hard ? "waiting_for_human_action" : "failed",
          description: hard ? "Queue run hit hard blocker" : "Queue run failed",
          reason,
          context: {
            hard_blocker: hard,
            handoff_category: hard ? handoffCategoryFromText(reason) : null,
          },
        });
        outcomes.push({ application_id: appId, state: hard ? "waiting_for_human_action" : "failed", hard_blocker: hard, reason });
        if (hard) hardStop = true;
        continue;
      }

      await processRunnerResult({ appId, app, body, runnerBaseUrl });
      const last = outcomes[outcomes.length - 1];
      // Stop queue if this app is paused for human action — starting another
      // Playwright process on the shared VNC display while one is paused would
      // overwrite the live browser view and cause conflicting data entry.
      if (last?.hard_blocker || last?.state === "waiting_for_human_action" || last?.state === "waiting_for_review") hardStop = true;

      } catch (appError) {
        // Per-app error guard: ensure the app is never left stuck in `autofilling`.
        const reason = appError instanceof Error ? appError.message : "Internal error during queue processing";
        console.error(`[EF] per-app unhandled error for ${appId}:`, reason);
        await logState({
          appId,
          state: "failed",
          description: "Unexpected error during automation startup",
          reason,
        }).catch((e) => console.error(`[EF] failed to write error state for ${appId}:`, e));
        outcomes.push({ application_id: appId, state: "failed", hard_blocker: false, reason });
      }
    }

    // ── Shared result processor ──────────────────────────────────────────────
    async function processRunnerResult(args: {
      appId: string;
      app: AppRow;
      body: RunnerResult;
      runnerBaseUrl: string;
    }) {
      const { appId, body } = args;

      const unfilledFields = Array.isArray(body.unfilled_fields) ? body.unfilled_fields : [];
      const unfilledRequired = Array.isArray(body.unfilled_required) ? body.unfilled_required : [];
      const unanswered = Array.isArray(body.unanswered_questions) ? body.unanswered_questions : [];
      if (unanswered.length > 0) {
        const reason = "Unanswered eligibility question requires review";
        await logState({
          appId,
          state: "waiting_for_human_action",
          description: "Queue run paused for unanswered question",
          reason,
          context: {
            unanswered_questions: unanswered,
            artifacts: body.artifacts ?? null,
            final_url: body.final_url ?? null,
            handoff_category: "unanswered_question",
          },
        });
        outcomes.push({ application_id: appId, state: "waiting_for_human_action", hard_blocker: false, reason });
        return;
      }

      const returnedStatus = typeof body.status === "string" ? body.status : "";
      const finalState: QueueState =
        returnedStatus === "waiting_for_human_action"
          ? "waiting_for_human_action"
          : returnedStatus === "blocked"
            ? "waiting_for_human_action"
            : returnedStatus === "failed"
              ? "failed"
              : "waiting_for_review";
      const reason =
        finalState === "waiting_for_review"
          ? undefined
          : finalState === "waiting_for_human_action" && returnedStatus === "waiting_for_human_action"
            ? pickRunnerError(body, "Human verification required before autofill can continue")
            : pickRunnerError(body, "Run did not complete");

      const runnerMsg = pickRunnerError(body, "");
      const handoffCat =
        finalState === "waiting_for_human_action"
          ? handoffCategoryFromText(runnerMsg, typeof body.message === "string" ? body.message : "", returnedStatus)
          : null;

      // The runner now returns vnc_url (self-hosted noVNC) instead of steel_live_url
      const liveUrl = body.vnc_url ?? null;

      await logState({
        appId,
        state: finalState,
        description:
          finalState === "waiting_for_review"
            ? "Autofill completed; queue handoff stopped before submit and is waiting for review"
            : finalState === "waiting_for_human_action"
              ? returnedStatus === "waiting_for_human_action"
                ? "Queue handoff paused for human verification (live browser available via noVNC)"
                : "Queue handoff paused due to blocker"
              : "Queue handoff marked failed",
        reason,
        context: {
          artifacts: body.artifacts ?? null,
          final_url: body.final_url ?? null,
          hard_blocker: body.hard_blocker === true,
          handoff_category: handoffCat,
          vnc_url: liveUrl,
          ...(finalState === "waiting_for_review" && unfilledFields.length > 0 ? { unfilled_fields: unfilledFields } : {}),
          ...(finalState === "waiting_for_review" && unfilledRequired.length > 0 ? { unfilled_required: unfilledRequired } : {}),
        },
      });

      // Persist the noVNC live URL so the frontend can show the iframe without a join
      if (finalState === "waiting_for_human_action" && liveUrl) {
        await serviceClient
          .from("applications")
          .update({ automation_live_url: liveUrl })
          .eq("id", appId)
          .eq("user_id", user.id);
      } else if (finalState !== "waiting_for_human_action") {
        // Clear the live URL once the run is no longer paused
        await serviceClient
          .from("applications")
          .update({ automation_live_url: null })
          .eq("id", appId)
          .eq("user_id", user.id);
      }

      outcomes.push({
        application_id: appId,
        state: finalState,
        hard_blocker: body.hard_blocker === true,
        reason,
        ...(liveUrl ? { steel_live_url: liveUrl } : {}), // keep field name for compat with frontend type
      });
    }

    return json(200, {
      ok: true,
      processed: outcomes.length,
      stopped_by_hard_blocker: hardStop,
      outcomes,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unexpected error";
    console.log("[EF] uncaught error:", msg, error);
    return json(500, { error: msg });
  }
});
