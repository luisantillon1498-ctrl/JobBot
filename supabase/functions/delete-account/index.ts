import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

function jsonOk(body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status: 200, headers: jsonHeaders });
}

/** Remove all objects under `{userId}/` in the documents bucket (best-effort). */
async function deleteUserStorageObjects(
  admin: ReturnType<typeof createClient>,
  userId: string,
): Promise<void> {
  const bucket = "documents";
  const pageSize = 500;
  let offset = 0;
  for (;;) {
    const { data, error } = await admin.storage.from(bucket).list(userId, {
      limit: pageSize,
      offset,
      sortBy: { column: "name", order: "asc" },
    });
    if (error) {
      console.warn("storage list error:", error.message);
      return;
    }
    if (!data?.length) break;
    const paths = data.map((f) => `${userId}/${f.name}`);
    const { error: rmErr } = await admin.storage.from(bucket).remove(paths);
    if (rmErr) console.warn("storage remove error:", rmErr.message);
    if (data.length < pageSize) break;
    offset += pageSize;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return jsonOk({ ok: false, error: "Method not allowed", code: "method" });
  }

  const authHeader = req.headers.get("authorization");
  if (!authHeader) {
    return jsonOk({ ok: false, error: "Not authenticated", code: "auth" });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  if (!supabaseUrl || !anonKey) {
    return jsonOk({ ok: false, error: "Server misconfigured", code: "config" });
  }
  if (!serviceKey) {
    return jsonOk({
      ok: false,
      error: "SUPABASE_SERVICE_ROLE_KEY is not set on this function (required to delete an account).",
      code: "config",
    });
  }

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const {
    data: { user },
    error: userErr,
  } = await userClient.auth.getUser();
  if (userErr || !user) {
    return jsonOk({ ok: false, error: "Invalid session", code: "auth" });
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    await deleteUserStorageObjects(admin, user.id);
  } catch (e) {
    console.warn("deleteUserStorageObjects:", e);
  }

  const { error: delErr } = await admin.auth.admin.deleteUser(user.id);
  if (delErr) {
    console.error("admin.deleteUser:", delErr);
    return jsonOk({
      ok: false,
      error: delErr.message || "Could not delete account",
      code: "delete_user",
    });
  }

  return jsonOk({ ok: true });
});
