import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

type Client = SupabaseClient<Database>;

/**
 * Returns the storage file_path of the tailored resume for this application.
 *
 * Resolution order:
 *  1. A resume document already linked to the application via application_documents.
 *  2. If none exists, invoke the generate-resume Edge Function to create one,
 *     then return the resulting storage_path.
 *  3. Returns null if generation fails or the runner is unavailable.
 */
export async function getOrGenerateApplicationResumePath(
  client: Client,
  applicationId: string,
): Promise<string | null> {
  // 1. Check application_documents → documents for an existing resume
  const { data: appDocs } = await client
    .from("application_documents")
    .select("documents(file_path, type)")
    .eq("application_id", applicationId);

  type LinkedDoc = { documents: { file_path: string; type: string } | null };
  const existing = (appDocs ?? []) as LinkedDoc[];
  const resumeRow = existing.find((r) => r.documents?.type === "resume");
  if (resumeRow?.documents?.file_path) {
    return resumeRow.documents.file_path;
  }

  // 2. No resume yet — generate one first
  const { data: genResult, error: genErr } = await client.functions.invoke("generate-resume", {
    body: { application_id: applicationId },
  });

  if (genErr) {
    console.warn("generate-resume invoke error:", genErr.message);
    return null;
  }

  const result = genResult as { ok?: boolean; storage_path?: string; error?: string } | null;

  if (!result?.ok) {
    console.warn("generate-resume returned error:", result?.error);
    return null;
  }

  return result.storage_path ?? null;
}
