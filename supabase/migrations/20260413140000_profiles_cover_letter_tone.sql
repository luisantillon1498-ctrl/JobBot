-- Default tone for AI-generated cover letters (user preference)
ALTER TABLE public.profiles
ADD COLUMN cover_letter_tone TEXT NOT NULL DEFAULT 'professional'
  CHECK (cover_letter_tone IN ('professional', 'warm', 'confident', 'concise', 'formal'));

COMMENT ON COLUMN public.profiles.cover_letter_tone IS 'Preferred voice for generated cover letters.';
