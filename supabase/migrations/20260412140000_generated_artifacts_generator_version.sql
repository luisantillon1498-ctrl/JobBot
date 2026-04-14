-- Version stamp for AI recipe / prompt template (set by edge function on insert).
ALTER TABLE public.generated_artifacts
  ADD COLUMN IF NOT EXISTS generator_version text;

UPDATE public.generated_artifacts
SET generator_version = 'legacy'
WHERE generator_version IS NULL;

ALTER TABLE public.generated_artifacts
  ALTER COLUMN generator_version SET NOT NULL;

ALTER TABLE public.generated_artifacts
  ALTER COLUMN generator_version SET DEFAULT 'legacy';

COMMENT ON COLUMN public.generated_artifacts.generator_version IS 'Bump in generate-cover-letter when prompt, system message, or inference recipe changes.';
