-- Add queue/audit fields for autofill + submission runs.
ALTER TABLE public.applications
ADD COLUMN IF NOT EXISTS automation_queue_state text NOT NULL DEFAULT 'waiting_for_review',
ADD COLUMN IF NOT EXISTS automation_last_run_at timestamp with time zone,
ADD COLUMN IF NOT EXISTS automation_last_outcome text,
ADD COLUMN IF NOT EXISTS automation_last_error text,
ADD COLUMN IF NOT EXISTS automation_last_context jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.applications
DROP CONSTRAINT IF EXISTS applications_automation_queue_state_check;
ALTER TABLE public.applications
ADD CONSTRAINT applications_automation_queue_state_check
CHECK (
  automation_queue_state IN (
    'autofill_started',
    'autofill_completed',
    'waiting_for_review',
    'ready_to_submit',
    'submitted',
    'blocked',
    'failed'
  )
);

ALTER TABLE public.applications
DROP CONSTRAINT IF EXISTS applications_automation_last_outcome_check;
ALTER TABLE public.applications
ADD CONSTRAINT applications_automation_last_outcome_check
CHECK (
  automation_last_outcome IS NULL OR automation_last_outcome IN (
    'autofill_started',
    'autofill_completed',
    'waiting_for_review',
    'ready_to_submit',
    'submitted',
    'blocked',
    'failed'
  )
);

-- Keep existing records consistent with existing submission status.
UPDATE public.applications
SET automation_queue_state = CASE
  WHEN submission_status = 'submitted' THEN 'submitted'
  ELSE 'waiting_for_review'
END
WHERE automation_queue_state IS NULL OR automation_queue_state = 'waiting_for_review';

COMMENT ON COLUMN public.applications.automation_queue_state IS
  'Latest queue state for automated job application runs.';
COMMENT ON COLUMN public.applications.automation_last_run_at IS
  'Timestamp of most recent automation attempt.';
COMMENT ON COLUMN public.applications.automation_last_outcome IS
  'Latest automation outcome state for analytics and retries.';
COMMENT ON COLUMN public.applications.automation_last_error IS
  'Failure reason when a run is blocked or fails.';
COMMENT ON COLUMN public.applications.automation_last_context IS
  'JSON context with run id, artifacts, URLs, and retry details for the latest run.';

-- Extend event type constraint to support append-only run-state lifecycle events.
ALTER TABLE public.application_events DROP CONSTRAINT IF EXISTS application_events_event_type_check;
ALTER TABLE public.application_events ADD CONSTRAINT application_events_event_type_check
  CHECK (event_type IN (
    'status_change',
    'note',
    'interview_scheduled',
    'document_generated',
    'follow_up',
    'outcome_change',
    'automation_status'
  ));
