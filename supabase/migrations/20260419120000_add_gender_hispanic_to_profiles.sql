-- Add demographic EEO fields to profiles
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS gender text,
  ADD COLUMN IF NOT EXISTS hispanic_ethnicity text;
