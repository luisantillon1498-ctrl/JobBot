import { supabase } from "@/integrations/supabase/client";

const supabaseUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.replace(/\/$/, "") ?? "";
const functionsApiKey =
  (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ||
  (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined) ||
  "";

/**
 * Values returned by `start-applying-queue` — aligned with `applications.automation_queue_state`.
 * Primary path: autofilling → waiting_for_human_action? → waiting_for_review → ready_to_submit (app) → submitted | failed.
 */
export type QueueOutcomeState =
  | "queued"
  | "autofilling"
  | "waiting_for_human_action"
  | "human_action_completed"
  | "waiting_for_review"
  | "ready_to_submit"
  | "submitted"
  | "failed";

export type QueueOutcome = {
  application_id: string;
  state: QueueOutcomeState;
  hard_blocker: boolean;
  reason?: string;
  steel_live_url?: string;
};

export type StartApplyingQueueOptions = {
  /** When set, only these applications are processed, in this order (must belong to the user, not excluded, with job_url). */
  applicationIds?: string[];
  /** When true, only applications currently in `waiting_for_human_action` are run. */
  resume?: boolean;
};

export type StartApplyingQueueResult = {
  processed: number;
  stopped_by_hard_blocker: boolean;
  outcomes: QueueOutcome[];
};

const ALLOWED_OUTCOME_STATES = new Set<QueueOutcomeState>([
  "queued",
  "autofilling",
  "waiting_for_human_action",
  "human_action_completed",
  "waiting_for_review",
  "ready_to_submit",
  "submitted",
  "failed",
]);

function parseQueueResult(json: Record<string, unknown>): StartApplyingQueueResult {
  const outcomes: QueueOutcome[] = Array.isArray(json.outcomes)
    ? json.outcomes
        .filter((item): item is Record<string, unknown> => {
          if (!item || typeof item !== "object") return false;
          const outcome = item as Record<string, unknown>;
          return (
            typeof outcome.application_id === "string" &&
            typeof outcome.state === "string" &&
            ALLOWED_OUTCOME_STATES.has(outcome.state as QueueOutcomeState) &&
            typeof outcome.hard_blocker === "boolean"
          );
        })
        .map((outcome) => ({
          application_id: outcome.application_id as string,
          state: outcome.state as QueueOutcomeState,
          hard_blocker: outcome.hard_blocker as boolean,
          ...(typeof outcome.reason === "string" ? { reason: outcome.reason } : {}),
          ...(typeof outcome.steel_live_url === "string" ? { steel_live_url: outcome.steel_live_url } : {}),
        }))
    : [];

  return {
    processed: typeof json.processed === "number" ? json.processed : outcomes.length,
    stopped_by_hard_blocker: json.stopped_by_hard_blocker === true,
    outcomes,
  };
}

async function invokeStartApplyingQueue(accessToken: string, options: StartApplyingQueueOptions): Promise<StartApplyingQueueResult> {
  const body: Record<string, unknown> = {};
  if (options.applicationIds && options.applicationIds.length > 0) {
    body.application_ids = options.applicationIds;
  }
  if (options.resume === true) {
    body.resume = true;
  }

  let res: Response;
  let json: Record<string, unknown> = {};
  try {
    res = await fetch(`${supabaseUrl}/functions/v1/start-applying-queue`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
        apikey: functionsApiKey,
      },
      body: JSON.stringify(body),
    });
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      json = {};
    }

    const pickError = (): string | undefined => {
      if (typeof json.error === "string" && json.error.trim()) return json.error.trim();
      if (typeof json.message === "string" && json.message.trim()) return json.message.trim();
      return undefined;
    };
    if (!res.ok) {
      throw new Error(
        pickError() ??
          `Queue handoff returned ${res.status}${res.statusText ? ` ${res.statusText}` : ""}. Check function logs in Supabase.`,
      );
    }
    return parseQueueResult(json);
  } catch (error) {
    const { data, error: invokeError } = await supabase.functions.invoke("start-applying-queue", { body });
    if (!invokeError && data && typeof data === "object") {
      return parseQueueResult(data as Record<string, unknown>);
    }

    const fetchFailed = error instanceof TypeError || (error instanceof Error && /failed to fetch/i.test(error.message));
    if (fetchFailed) {
      throw new Error(
        "Could not reach Edge Function start-applying-queue (network/fetch failure). Verify the function is deployed and your Supabase URL/key are correct, then try again.",
      );
    }

    if (error instanceof Error) throw error;
    throw new Error("Could not start queue handoff.");
  }
}

/**
 * Start (or resume) server-side browser automation for the queue.
 * Pass `applicationIds` to restrict and order processing; omit for full DB queue behavior.
 */
export async function startApplyingQueue(options: StartApplyingQueueOptions = {}): Promise<StartApplyingQueueResult> {
  if (!supabaseUrl || !functionsApiKey) {
    throw new Error("Missing Supabase URL or anon/publishable key for Edge Functions.");
  }

  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) {
    throw new Error("You need to be signed in to start the queue.");
  }

  return invokeStartApplyingQueue(accessToken, options);
}

/**
 * Run one Edge invocation per application id so the UI can refresh between items.
 */
export async function startApplyingQueueSequential(
  applicationIds: string[],
  options: Pick<StartApplyingQueueOptions, "resume">,
  onProgress: (applicationId: string | null) => void,
): Promise<StartApplyingQueueResult> {
  const outcomes: QueueOutcome[] = [];
  let stopped = false;
  let processed = 0;
  for (const id of applicationIds) {
    onProgress(id);
    const res = await startApplyingQueue({ applicationIds: [id], resume: options.resume });
    processed += res.processed;
    outcomes.push(...res.outcomes);
    if (res.stopped_by_hard_blocker) {
      stopped = true;
      break;
    }
  }
  onProgress(null);
  return { processed, stopped_by_hard_blocker: stopped, outcomes };
}
