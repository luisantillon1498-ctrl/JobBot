-- Repair migration for environments that missed prior automation schema migrations.
-- Safe to run multiple times.

ALTER TABLE public.applications
ADD COLUMN IF NOT EXISTS automation_queue_state text NOT NULL DEFAULT 'waiting_for_review',
ADD COLUMN IF NOT EXISTS automation_last_run_at timestamp with time zone,
ADD COLUMN IF NOT EXISTS automation_last_outcome text,
ADD COLUMN IF NOT EXISTS automation_last_error text,
ADD COLUMN IF NOT EXISTS automation_last_context jsonb NOT NULL DEFAULT '{}'::jsonb,
ADD COLUMN IF NOT EXISTS automation_queue_priority integer NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS automation_queue_excluded boolean NOT NULL DEFAULT false;

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

UPDATE public.applications
SET automation_queue_state = CASE
  WHEN submission_status = 'submitted' THEN 'submitted'
  ELSE 'waiting_for_review'
END
WHERE automation_queue_state IS NULL OR automation_queue_state = '';

ALTER TABLE public.application_events
DROP CONSTRAINT IF EXISTS application_events_event_type_check;
ALTER TABLE public.application_events
ADD CONSTRAINT application_events_event_type_check
CHECK (
  event_type IN (
    'status_change',
    'note',
    'interview_scheduled',
    'document_generated',
    'follow_up',
    'outcome_change',
    'automation_status'
  )
);
