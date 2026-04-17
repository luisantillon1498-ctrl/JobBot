-- Steel.dev managed browser session support: store session ID and live-view URL
-- so the runner can hand off CAPTCHA challenges to a user-controlled browser tab.

-- ─── application_automation_sessions columns ─────────────────────────────────

ALTER TABLE public.application_automation_sessions
  ADD COLUMN IF NOT EXISTS steel_session_id TEXT;
-- Unique session identifier returned by Steel.dev when a managed browser session
-- is created (used to resume or release the session via the Steel API).

COMMENT ON COLUMN public.application_automation_sessions.steel_session_id IS
  'Steel.dev session ID for the managed browser created when a CAPTCHA or human handoff is required.';

ALTER TABLE public.application_automation_sessions
  ADD COLUMN IF NOT EXISTS steel_live_url TEXT;
-- The live-view URL vended by Steel.dev that lets the user observe and interact
-- with the managed browser (e.g. solve a CAPTCHA in real time).

COMMENT ON COLUMN public.application_automation_sessions.steel_live_url IS
  'Steel.dev live-view URL for the managed browser session; opened by the user to complete a CAPTCHA or manual step.';

-- ─── applications shortcut column ────────────────────────────────────────────

ALTER TABLE public.applications
  ADD COLUMN IF NOT EXISTS automation_live_url TEXT;
-- Denormalised copy of the active Steel.dev live-view URL for the application.
-- Kept in sync by the runner so the frontend can surface it without joining to
-- application_automation_sessions.

COMMENT ON COLUMN public.applications.automation_live_url IS
  'Active Steel.dev live-view URL for fast frontend access; mirrors steel_live_url on the current automation session (no join required).';
