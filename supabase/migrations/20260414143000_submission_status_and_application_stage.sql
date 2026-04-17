-- Split "draft/submitted" from application stage progression.
ALTER TABLE public.applications
ADD COLUMN IF NOT EXISTS submission_status text NOT NULL DEFAULT 'draft';

-- Backfill submission status from prior application_status + applied_at.
UPDATE public.applications
SET submission_status = CASE
  WHEN application_status = 'draft' AND applied_at IS NULL THEN 'draft'
  ELSE 'submitted'
END;

-- Move old draft/applied status values into a neutral stage.
UPDATE public.applications
SET application_status = 'not_started'
WHERE application_status IN ('draft', 'applied') OR application_status IS NULL;

ALTER TABLE public.applications
DROP CONSTRAINT IF EXISTS applications_submission_status_check;
ALTER TABLE public.applications
ADD CONSTRAINT applications_submission_status_check
CHECK (submission_status IN ('draft', 'submitted'));

ALTER TABLE public.applications
DROP CONSTRAINT IF EXISTS applications_application_status_check;
ALTER TABLE public.applications
ADD CONSTRAINT applications_application_status_check
CHECK (
  application_status IN (
    'not_started',
    'screening',
    'first_round_interview',
    'second_round_interview',
    'final_round_interview'
  )
);

COMMENT ON COLUMN public.applications.submission_status IS
  'Submission state: draft or submitted.';

COMMENT ON COLUMN public.applications.application_status IS
  'Application stage after submission (not_started, screening, interview rounds).';
