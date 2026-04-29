import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Require a valid auth header so the runner URL is not exposed to unauthenticated callers.
  const authHeader = req.headers.get("authorization");
  if (!authHeader) {
    return new Response(JSON.stringify({ ok: false, error: "Not authenticated" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const runnerUrl = Deno.env.get("JOBPAL_AUTOMATION_RUNNER_URL")?.trim();
    if (!runnerUrl) {
      return new Response(JSON.stringify({ ok: false, error: "Missing JOBPAL_AUTOMATION_RUNNER_URL" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const healthUrl = runnerUrl.replace(/\/run\/?$/, "/healthz");
    const healthRes = await fetch(healthUrl, {
      method: "GET",
      signal: AbortSignal.timeout(15_000),
    });

    const healthBody = await healthRes.text();
    return new Response(
      JSON.stringify({
        ok: healthRes.ok,
        status: healthRes.status,
        runner_url: runnerUrl,
        health_url: healthUrl,
        body: healthBody,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
