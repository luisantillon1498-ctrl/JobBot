-- Align application_events.event_type CHECK with app usage (ApplicationDetail outcome updates).
ALTER TABLE public.application_events DROP CONSTRAINT IF EXISTS application_events_event_type_check;

ALTER TABLE public.application_events ADD CONSTRAINT application_events_event_type_check
  CHECK (event_type IN (
    'status_change',
    'note',
    'interview_scheduled',
    'document_generated',
    'follow_up',
    'outcome_change'
  ));
