-- Add middle name and keep full_name as a computed compatibility field.
ALTER TABLE public.profiles
ADD COLUMN middle_name TEXT;

COMMENT ON COLUMN public.profiles.middle_name IS 'Optional middle name for job application forms.';

-- Backfill middle_name heuristically from existing full_name where possible.
UPDATE public.profiles
SET middle_name = NULLIF(
  trim(
    regexp_replace(
      regexp_replace(trim(full_name), '^\S+\s*', ''),
      '\s+\S+$',
      ''
    )
  ),
  ''
)
WHERE full_name IS NOT NULL
  AND trim(full_name) <> ''
  AND middle_name IS NULL;

-- Update signup profile creation to capture middle name metadata if present.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  meta_name text;
  meta_first text;
  meta_middle text;
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

  meta_middle := NULLIF(trim(NEW.raw_user_meta_data ->> 'middle_name'), '');

  meta_last := COALESCE(
    NULLIF(trim(NEW.raw_user_meta_data ->> 'last_name'), ''),
    NULLIF(trim(regexp_replace(COALESCE(meta_name, ''), '^\S+(\s+\S+)?\s*', '')), '')
  );

  INSERT INTO public.profiles (user_id, full_name, first_name, middle_name, last_name)
  VALUES (NEW.id, meta_name, meta_first, meta_middle, meta_last);
  RETURN NEW;
END;
$$;
