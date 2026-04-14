import type { User } from "@supabase/supabase-js";

/** Name stored in auth user_metadata (e.g. sign-up data or OAuth). */
export function nameFromUserMetadata(user: User | null | undefined): string {
  if (!user) return "";
  const meta = user.user_metadata as Record<string, unknown>;
  const candidates = [meta.full_name, meta.name, meta.display_name, meta.preferred_username];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return "";
}
