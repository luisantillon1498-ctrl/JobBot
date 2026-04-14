-- Track which resume and cover letter were used when submitting an application (one of each).
ALTER TABLE public.applications
ADD COLUMN IF NOT EXISTS submitted_resume_document_id uuid REFERENCES public.documents(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS submitted_cover_document_id uuid REFERENCES public.documents(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.applications.submitted_resume_document_id IS 'Vault document (type resume) marked as used when applying.';
COMMENT ON COLUMN public.applications.submitted_cover_document_id IS 'Vault document (cover letter) marked as used when applying; may be synced from a generated artifact.';

-- Link vault rows created from a generated cover letter back to the artifact (dedupe / traceability).
ALTER TABLE public.documents
ADD COLUMN IF NOT EXISTS source_generated_artifact_id uuid REFERENCES public.generated_artifacts(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS documents_user_source_generated_artifact_idx
ON public.documents (user_id, source_generated_artifact_id)
WHERE source_generated_artifact_id IS NOT NULL;
