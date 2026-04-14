
-- Add new columns to applications
ALTER TABLE public.applications 
ADD COLUMN application_status text NOT NULL DEFAULT 'draft',
ADD COLUMN outcome text DEFAULT NULL;

-- Migrate existing status data
UPDATE public.applications SET 
  application_status = CASE 
    WHEN status IN ('draft', 'applied', 'screening', 'interviewing') THEN 
      CASE status
        WHEN 'interviewing' THEN 'first_round_interview'
        ELSE status
      END
    WHEN status IN ('offer', 'accepted') THEN 'final_round_interview'
    WHEN status IN ('rejected', 'withdrawn') THEN 
      COALESCE(
        CASE WHEN applied_at IS NOT NULL THEN 'applied' ELSE 'draft' END,
        'draft'
      )
    ELSE 'draft'
  END,
  outcome = CASE 
    WHEN status = 'rejected' THEN 'rejected'
    WHEN status = 'withdrawn' THEN 'withdrew'
    WHEN status = 'accepted' THEN 'offer_accepted'
    WHEN status = 'offer' THEN 'offer_accepted'
    ELSE NULL
  END;

-- Drop old status column
ALTER TABLE public.applications DROP COLUMN status;

-- Create application_documents junction table
CREATE TABLE public.application_documents (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  application_id uuid NOT NULL REFERENCES public.applications(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  user_id uuid NOT NULL,
  UNIQUE(application_id, document_id)
);

ALTER TABLE public.application_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own application documents"
ON public.application_documents FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own application documents"
ON public.application_documents FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own application documents"
ON public.application_documents FOR DELETE
USING (auth.uid() = user_id);
