import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  // Require auth — any valid JWT is enough (the runner does its own token check)
  const authHeader = req.headers.get("authorization");
  if (!authHeader) return json(401, { error: "Not authenticated" });

  let applicationId: string | undefined;
  let killAll = false;
  try {
    const body = (await req.json()) as Record<string, unknown>;
    if (typeof body.application_id === "string" && body.application_id.trim()) {
      applicationId = body.application_id.trim();
    }
    if (body.kill_all === true) killAll = true;
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const runnerUrl = Deno.env.get("JOBPAL_AUTOMATION_RUNNER_URL")?.trim();
  const runnerToken = Deno.env.get("JOBPAL_AUTOMATION_RUNNER_TOKEN")?.trim();
  if (!runnerUrl) return json(500, { error: "Missing JOBPAL_AUTOMATION_RUNNER_URL" });

  const runnerBaseUrl = runnerUrl.replace(/\/run\/?$/, "").replace(/\/$/, "");

  try {
    const res = await fetch(`${runnerBaseUrl}/kill-session`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(runnerToken ? { Authorization: `Bearer ${runnerToken}` } : {}),
      },
      body: JSON.stringify({
        ...(applicationId ? { application_id: applicationId } : {}),
        ...(killAll ? { kill_all: true } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    });

    let body: Record<string, unknown> = {};
    try { body = (await res.json()) as Record<string, unknown>; } catch { body = {}; }

    if (!res.ok) {
      return json(502, { ok: false, error: body.error ?? `Runner returned ${res.status}` });
    }

    return json(200, body);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Could not reach runner";
    return json(502, { ok: false, error: msg });
  }
});
