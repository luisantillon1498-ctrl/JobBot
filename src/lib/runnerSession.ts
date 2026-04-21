import { supabase } from "@/integrations/supabase/client";

const supabaseUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.replace(/\/$/, "") ?? "";
const functionsApiKey =
  (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ||
  (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined) ||
  "";

/**
 * Kill the active VNC/Playwright session for a specific application (or all sessions).
 * Used when deleting an application or when the user wants to free the runner for a
 * different job.
 *
 * Silently succeeds if no session is running for this application.
 */
export async function killRunnerSession(applicationId?: string): Promise<{ killed: boolean; message: string }> {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error("Not authenticated");

  const body: Record<string, unknown> = {};
  if (applicationId) body.application_id = applicationId;

  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/kill-runner-session`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
        apikey: functionsApiKey,
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return {
      killed: json.killed === true,
      message: typeof json.message === "string" ? json.message : "",
    };
  } catch {
    // Best-effort — don't block the delete flow if the runner is unreachable
    return { killed: false, message: "Runner unreachable — session may still be active" };
  }
}
