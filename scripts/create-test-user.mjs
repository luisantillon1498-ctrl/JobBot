/**
 * Creates a test user account directly via the Supabase Admin API.
 * Email confirmation is bypassed — the account is immediately usable.
 * The handle_new_user trigger will create the matching profiles row automatically.
 *
 * Usage:
 *   SUPABASE_URL=https://xxx.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=eyJ... \
 *   node scripts/create-test-user.mjs
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error(
    "Missing required env vars.\n" +
    "Run with:\n" +
    "  SUPABASE_URL=https://xxx.supabase.co SUPABASE_SERVICE_ROLE_KEY=eyJ... node scripts/create-test-user.mjs"
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data, error } = await supabase.auth.admin.createUser({
  email: "johnsmithdsailproject@gmail.com",
  password: "123456",
  email_confirm: true,           // skip confirmation email
  user_metadata: {
    full_name: "John Smith",     // picked up by handle_new_user trigger → profiles.full_name
  },
});

if (error) {
  console.error("Failed to create user:", error.message);
  process.exit(1);
}

console.log("User created successfully.");
console.log("  ID:    ", data.user.id);
console.log("  Email: ", data.user.email);
console.log("  Name:  ", data.user.user_metadata?.full_name);
