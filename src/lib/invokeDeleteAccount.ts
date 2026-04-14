import { supabase } from "@/integrations/supabase/client";

const supabaseUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.replace(/\/$/, "") ?? "";
const functionsApiKey =
  (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ||
  (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined) ||
  "";

export async function invokeDeleteAccount(): Promise<void> {
  if (!supabaseUrl || !functionsApiKey) {
    throw new Error("Missing VITE_SUPABASE_URL or anon/publishable key for Edge Functions.");
  }

  const { error: userError } = await supabase.auth.getUser();
  if (userError) {
    throw new Error("Your session has expired. Please sign in again.");
  }
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) {
    throw new Error("You need to be signed in.");
  }

  const url = `${supabaseUrl}/functions/v1/delete-account`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      apikey: functionsApiKey,
    },
    body: "{}",
  });

  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    /* non-JSON */
  }

  const msg =
    typeof json.error === "string" && json.error.trim()
      ? json.error.trim()
      : !res.ok
        ? `Request failed (${res.status})`
        : "Could not delete account.";

  if (!res.ok || json.ok === false) {
    throw new Error(msg);
  }
}
