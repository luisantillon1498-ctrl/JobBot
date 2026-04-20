-- Safety migration: guarantee every column queried by the automation
-- Edge Function exists on the profiles table.  ADD COLUMN IF NOT EXISTS
-- is a no-op when the column already exists, so this is safe to run
-- even if all previous migrations applied cleanly.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS first_name             TEXT,
  ADD COLUMN IF NOT EXISTS middle_name            TEXT,
  ADD COLUMN IF NOT EXISTS last_name              TEXT,
  ADD COLUMN IF NOT EXISTS professional_email     TEXT,
  ADD COLUMN IF NOT EXISTS city                   TEXT,
  ADD COLUMN IF NOT EXISTS state_region           TEXT,
  ADD COLUMN IF NOT EXISTS country                TEXT,
  ADD COLUMN IF NOT EXISTS veteran_status         TEXT,
  ADD COLUMN IF NOT EXISTS disability_status      TEXT,
  ADD COLUMN IF NOT EXISTS gender                 TEXT,
  ADD COLUMN IF NOT EXISTS hispanic_ethnicity     TEXT,
  ADD COLUMN IF NOT EXISTS race_ethnicity         TEXT;

-- phone and linkedin_url were in the original CREATE TABLE so they always exist.
-- default_resume_document_id is already guarded with IF NOT EXISTS in its own migration.
