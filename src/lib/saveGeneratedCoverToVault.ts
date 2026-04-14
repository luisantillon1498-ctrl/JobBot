import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { sanitizeStorageFileName } from "@/lib/utils";

const PG_INT_MAX = 2147483647;

type Artifact = { id: string; content: string };

/**
 * Ensures a generated cover letter exists as a vault document (storage + documents row),
 * is linked to the application, and returns the document id.
 */
export async function ensureGeneratedCoverLetterInVault(
  supabase: SupabaseClient<Database>,
  params: {
    userId: string;
    applicationId: string;
    artifact: Artifact;
    companyName: string;
    jobTitle: string;
  },
): Promise<{ documentId: string } | { error: string }> {
  const { userId, applicationId, artifact, companyName, jobTitle } = params;

  const { data: existing } = await supabase
    .from("documents")
    .select("id, file_path")
    .eq("user_id", userId)
    .eq("source_generated_artifact_id", artifact.id)
    .maybeSingle();

  if (existing?.id) {
    const { error: linkErr } = await supabase.from("application_documents").insert({
      application_id: applicationId,
      document_id: existing.id,
      user_id: userId,
    });
    if (linkErr && linkErr.code !== "23505") {
      return { error: linkErr.message || "Could not link document to application" };
    }
    return { documentId: existing.id };
  }

  const displayName = `Cover letter — ${companyName} — ${jobTitle}.txt`;
  const safeBase = sanitizeStorageFileName(
    `cover_${companyName}_${jobTitle}_${artifact.id.slice(0, 8)}.txt`,
  );
  const filePath = `${userId}/${Date.now()}_${safeBase}`;
  const blob = new Blob([artifact.content], { type: "text/plain;charset=utf-8" });
  const { error: uploadError } = await supabase.storage.from("documents").upload(filePath, blob, {
    contentType: "text/plain;charset=utf-8",
    upsert: false,
  });
  if (uploadError) {
    return { error: uploadError.message || "Upload failed" };
  }

  const byteLen = new Blob([artifact.content]).size;
  const file_size = byteLen > PG_INT_MAX ? null : byteLen;

  const { data: inserted, error: insertErr } = await supabase
    .from("documents")
    .insert({
      user_id: userId,
      name: displayName,
      type: "cover_letter_template",
      file_path: filePath,
      file_size,
      source_generated_artifact_id: artifact.id,
    })
    .select("id")
    .single();

  if (insertErr || !inserted) {
    await supabase.storage.from("documents").remove([filePath]);
    return { error: insertErr?.message || "Could not save document record" };
  }

  const { error: linkErr } = await supabase.from("application_documents").insert({
    application_id: applicationId,
    document_id: inserted.id,
    user_id: userId,
  });
  if (linkErr && linkErr.code !== "23505") {
    return { error: linkErr.message || "Could not attach document" };
  }

  return { documentId: inserted.id };
}
