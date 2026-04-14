-- Run in Supabase Dashboard → SQL Editor if GET .../rest/v1/application_documents returns 404
-- (PostgREST returns 404 when the relation does not exist — unrelated to client embed syntax.)

CREATE TABLE IF NOT EXISTS public.application_documents (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  application_id uuid NOT NULL REFERENCES public.applications(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  user_id uuid NOT NULL,
  UNIQUE(application_id, document_id)
);

ALTER TABLE public.application_documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own application documents" ON public.application_documents;
DROP POLICY IF EXISTS "Users can insert own application documents" ON public.application_documents;
DROP POLICY IF EXISTS "Users can delete own application documents" ON public.application_documents;

CREATE POLICY "Users can view own application documents"
ON public.application_documents FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own application documents"
ON public.application_documents FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own application documents"
ON public.application_documents FOR DELETE
USING (auth.uid() = user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.application_documents TO authenticated, service_role;
