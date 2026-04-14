-- Default resume for cover letter generation (chosen in Document Vault)
ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS default_resume_document_id UUID REFERENCES public.documents (id) ON DELETE SET NULL;

COMMENT ON COLUMN public.profiles.default_resume_document_id IS 'Resume document used by default for AI cover letters; null = use most recently uploaded resume.';

CREATE OR REPLACE FUNCTION public.profiles_validate_default_resume_document()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.default_resume_document_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.documents d
    WHERE d.id = NEW.default_resume_document_id
      AND d.user_id = NEW.user_id
      AND d.type = 'resume'
  ) THEN
    RAISE EXCEPTION 'default_resume_document_id must reference a resume owned by the same user';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_validate_default_resume_document_trigger ON public.profiles;
CREATE TRIGGER profiles_validate_default_resume_document_trigger
  BEFORE INSERT OR UPDATE OF default_resume_document_id ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.profiles_validate_default_resume_document();
