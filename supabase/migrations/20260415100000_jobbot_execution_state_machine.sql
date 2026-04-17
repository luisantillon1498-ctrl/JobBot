-- JobBot: execution state machine (human handoff / captcha-safe pauses) + per-run session audit.
-- Queue order and exclusions remain on public.applications (automation_queue_priority, automation_queue_excluded).

-- ─── Per-run session (autofill / browser run, handoff, screenshots, logs) ─────
CREATE TABLE public.application_automation_sessions (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  application_id uuid NOT NULL REFERENCES public.applications (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  started_at timestamp with time zone NOT NULL DEFAULT now(),
  ended_at timestamp with time zone,
  handoff_reason text,
  handoff_required_at timestamp with time zone,
  handoff_completed_at timestamp with time zone,
  screenshot_storage_paths jsonb NOT NULL DEFAULT '[]'::jsonb,
  run_log jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX application_automation_sessions_application_id_idx
  ON public.application_automation_sessions (application_id);

CREATE INDEX application_automation_sessions_user_started_idx
  ON public.application_automation_sessions (user_id, started_at DESC);

COMMENT ON TABLE public.application_automation_sessions IS
  'One row per JobBot browser/autofill attempt; optional handoff timestamps, screenshot paths, structured run_log.';

COMMENT ON COLUMN public.application_automation_sessions.screenshot_storage_paths IS
  'JSON array of strings: storage object paths (project convention, e.g. documents bucket keys).';

COMMENT ON COLUMN public.application_automation_sessions.run_log IS
  'JSON array of entries, e.g. [{"at":"...","level":"info","message":"..."}].';

COMMENT ON COLUMN public.application_automation_sessions.handoff_reason IS
  'Why automation paused for human action (e.g. captcha, login, mfa, unknown_field).';

CREATE TRIGGER update_application_automation_sessions_updated_at
  BEFORE UPDATE ON public.application_automation_sessions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.application_automation_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own automation sessions"
  ON public.application_automation_sessions FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own automation sessions"
  ON public.application_automation_sessions FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own automation sessions"
  ON public.application_automation_sessions FOR UPDATE
  USING (auth.uid() = user_id);

-- ─── Active session pointer on applications ───────────────────────────────────
ALTER TABLE public.applications
  ADD COLUMN IF NOT EXISTS automation_active_session_id uuid REFERENCES public.application_automation_sessions (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS applications_automation_active_session_id_idx
  ON public.applications (automation_active_session_id)
  WHERE automation_active_session_id IS NOT NULL;

COMMENT ON COLUMN public.applications.automation_active_session_id IS
  'Currently focused automation session for this application (browser run / handoff).';

-- ─── State machine: replace legacy automation_queue_state / last_outcome values
ALTER TABLE public.applications
  DROP CONSTRAINT IF EXISTS applications_automation_queue_state_check;

ALTER TABLE public.applications
  DROP CONSTRAINT IF EXISTS applications_automation_last_outcome_check;

UPDATE public.applications
SET automation_queue_state = CASE automation_queue_state
    WHEN 'autofill_started' THEN 'autofilling'
    WHEN 'autofill_completed' THEN 'waiting_for_review'
    WHEN 'blocked' THEN 'waiting_for_human_action'
    ELSE automation_queue_state
  END;

UPDATE public.applications
SET automation_last_outcome = CASE automation_last_outcome
    WHEN 'autofill_started' THEN 'autofilling'
    WHEN 'autofill_completed' THEN 'waiting_for_review'
    WHEN 'blocked' THEN 'waiting_for_human_action'
    ELSE automation_last_outcome
  END
WHERE automation_last_outcome IS NOT NULL;

ALTER TABLE public.applications
  ADD CONSTRAINT applications_automation_queue_state_check
  CHECK (
    automation_queue_state IN (
      'queued',
      'autofilling',
      'waiting_for_human_action',
      'human_action_completed',
      'waiting_for_review',
      'ready_to_submit',
      'submitted',
      'failed'
    )
  );

ALTER TABLE public.applications
  ADD CONSTRAINT applications_automation_last_outcome_check
  CHECK (
    automation_last_outcome IS NULL
    OR automation_last_outcome IN (
      'queued',
      'autofilling',
      'waiting_for_human_action',
      'human_action_completed',
      'waiting_for_review',
      'ready_to_submit',
      'submitted',
      'failed'
    )
  );

ALTER TABLE public.applications
  ALTER COLUMN automation_queue_state SET DEFAULT 'queued';

COMMENT ON COLUMN public.applications.automation_queue_state IS
  'JobBot execution state: queued → autofilling → (waiting_for_human_action ↔ human_action_completed) → waiting_for_review → ready_to_submit → submitted | failed.';

COMMENT ON COLUMN public.applications.automation_queue_priority IS
  'Per-user queue ordering (lower runs first).';

COMMENT ON COLUMN public.applications.automation_queue_excluded IS
  'When true, JobBot skips this application in queue runs.';
