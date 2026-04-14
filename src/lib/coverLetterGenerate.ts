import { supabase } from "@/integrations/supabase/client";

const supabaseUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.replace(/\/$/, "") ?? "";
/** Edge Functions gateway expects the legacy anon JWT in `apikey` when using a user Bearer token. */
const functionsApiKey =
  (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ||
  (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined) ||
  "";

export type GenerateCoverLetterBody = {
  application_id: string;
  job_title: string;
  company_name: string;
  job_description: string;
  resume_path: string | null;
};

/**
 * Calls the Edge Function via `fetch` instead of `supabase.functions.invoke`.
 * Invoke often surfaces only "Edge Function returned a non-2xx status code" even when the body
 * explains the failure; fetch always lets us read JSON and show the real message.
 */
export async function invokeGenerateCoverLetter(body: GenerateCoverLetterBody): Promise<{
  content: string;
  generator_version?: string;
}> {
  if (!supabaseUrl || !functionsApiKey) {
    throw new Error("Missing VITE_SUPABASE_URL or anon/publishable key for Edge Functions.");
  }

  // getSession() alone can return an expired JWT from local storage; getUser() hits the auth server
  // and updates the session when the user is still valid.
  const { error: userError } = await supabase.auth.getUser();
  if (userError) {
    throw new Error("Your session has expired. Please sign in again.");
  }
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) {
    throw new Error("You need to be signed in to generate a cover letter.");
  }

  const url = `${supabaseUrl}/functions/v1/generate-cover-letter`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      apikey: functionsApiKey,
    },
    body: JSON.stringify(body),
  });

  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    /* non-JSON body */
  }

  const pickError = (): string | undefined => {
    if (typeof json.error === "string" && json.error.trim()) return json.error.trim();
    if (typeof json.msg === "string" && json.msg.trim()) return json.msg.trim();
    if (typeof json.message === "string" && json.message.trim()) return json.message.trim();
    return undefined;
  };

  if (!res.ok) {
    throw new Error(
      pickError() ??
        `Cover letter service returned ${res.status}${res.statusText ? ` ${res.statusText}` : ""}. Check the function logs in Supabase.`,
    );
  }

  if (json.ok === false) {
    throw new Error(pickError() ?? "Cover letter generation failed.");
  }

  if (typeof json.content === "string") {
    return {
      content: json.content,
      generator_version: typeof json.generator_version === "string" ? json.generator_version : undefined,
    };
  }

  throw new Error(pickError() ?? "Unexpected response from cover letter service.");
}
