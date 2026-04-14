-- Copy display name from auth metadata into profiles when the account is created (sign-up data / OAuth).
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  meta_name text;
BEGIN
  meta_name := COALESCE(
    NULLIF(trim(NEW.raw_user_meta_data ->> 'full_name'), ''),
    NULLIF(trim(NEW.raw_user_meta_data ->> 'name'), ''),
    NULLIF(trim(NEW.raw_user_meta_data ->> 'display_name'), '')
  );
  INSERT INTO public.profiles (user_id, full_name)
  VALUES (NEW.id, meta_name);
  RETURN NEW;
END;
$$;
