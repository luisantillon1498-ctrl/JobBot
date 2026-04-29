/** PostgREST / Supabase when a column is not in the schema cache (migration not applied). */
export function isMissingProfilesColumnError(err: { message?: string; code?: string } | null | undefined): boolean {
  if (!err) return false;
  if (err.code === "PGRST204") return true;
  const m = (err.message ?? "").toLowerCase();
  return (
    (m.includes("profiles") && m.includes("schema cache")) ||
    (m.includes("column") && m.includes("does not exist"))
  );
}

export function isMissingCoverLetterToneColumnError(err: { message?: string; code?: string } | null | undefined): boolean {
  if (!err) return false;
  const m = (err.message ?? "").toLowerCase();
  return m.includes("cover_letter_tone") || isMissingProfilesColumnError(err);
}
