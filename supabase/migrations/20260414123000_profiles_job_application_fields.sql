-- Expand profile with common job-application personal fields.
ALTER TABLE public.profiles
ADD COLUMN first_name TEXT,
ADD COLUMN last_name TEXT,
ADD COLUMN professional_email TEXT,
ADD COLUMN address_line1 TEXT,
ADD COLUMN address_line2 TEXT,
ADD COLUMN city TEXT,
ADD COLUMN state_region TEXT,
ADD COLUMN postal_code TEXT,
ADD COLUMN country TEXT,
ADD COLUMN date_of_birth DATE,
ADD COLUMN veteran_status TEXT NOT NULL DEFAULT 'not_specified'
  CHECK (veteran_status IN ('not_specified', 'not_a_protected_veteran', 'protected_veteran', 'decline_to_answer')),
ADD COLUMN disability_status TEXT NOT NULL DEFAULT 'not_specified'
  CHECK (disability_status IN ('not_specified', 'no_disability', 'has_disability', 'decline_to_answer'));

COMMENT ON COLUMN public.profiles.professional_email IS 'Email to use in job applications; may differ from account email.';
COMMENT ON COLUMN public.profiles.veteran_status IS 'Self-reported veteran status for application forms.';
COMMENT ON COLUMN public.profiles.disability_status IS 'Self-reported disability status for application forms.';

-- Backfill first/last name where possible from existing full_name.
UPDATE public.profiles
SET
  first_name = COALESCE(first_name, NULLIF(split_part(trim(full_name), ' ', 1), '')),
  last_name = COALESCE(
    last_name,
    NULLIF(
      trim(regexp_replace(trim(full_name), '^\\S+\\s*', '')),
      ''
    )
  )
WHERE full_name IS NOT NULL
  AND trim(full_name) <> '';

-- Keep signup profile creation in sync with the new fields.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  meta_name text;
  meta_first text;
  meta_last text;
BEGIN
  meta_name := COALESCE(
    NULLIF(trim(NEW.raw_user_meta_data ->> 'full_name'), ''),
    NULLIF(trim(NEW.raw_user_meta_data ->> 'name'), ''),
    NULLIF(trim(NEW.raw_user_meta_data ->> 'display_name'), '')
  );

  meta_first := COALESCE(
    NULLIF(trim(NEW.raw_user_meta_data ->> 'first_name'), ''),
    NULLIF(split_part(meta_name, ' ', 1), '')
  );

  meta_last := COALESCE(
    NULLIF(trim(NEW.raw_user_meta_data ->> 'last_name'), ''),
    NULLIF(trim(regexp_replace(COALESCE(meta_name, ''), '^\\S+\\s*', '')), '')
  );

  INSERT INTO public.profiles (user_id, full_name, first_name, last_name)
  VALUES (NEW.id, meta_name, meta_first, meta_last);
  RETURN NEW;
END;
$$;
