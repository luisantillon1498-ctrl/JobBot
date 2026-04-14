import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { isMissingDefaultResumeColumnError } from "@/lib/supabaseSchemaHints";

type Client = SupabaseClient<Database>;

/**
 * File path for the user's resume used in cover letter generation:
 * profile default if set and still valid, otherwise most recently uploaded resume.
 */
export async function getResumePathForGeneration(client: Client, userId: string): Promise<string | null> {
  const { data: profile, error: profileErr } = await client
    .from("profiles")
    .select("default_resume_document_id")
    .eq("user_id", userId)
    .maybeSingle();

  if (profileErr && isMissingDefaultResumeColumnError(profileErr)) {
    /* Migration not applied — use latest resume only. */
  } else if (!profileErr) {
    const defaultId = profile?.default_resume_document_id ?? null;
    if (defaultId) {
      const { data: doc } = await client
        .from("documents")
        .select("file_path")
        .eq("id", defaultId)
        .eq("user_id", userId)
        .eq("type", "resume")
        .maybeSingle();
      if (doc?.file_path) return doc.file_path;
    }
  }

  const { data: latest } = await client
    .from("documents")
    .select("file_path")
    .eq("user_id", userId)
    .eq("type", "resume")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return latest?.file_path ?? null;
}
