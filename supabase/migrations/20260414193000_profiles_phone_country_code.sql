-- Store calling code separately from local phone number for job application forms.
ALTER TABLE public.profiles
ADD COLUMN phone_country_code TEXT;

COMMENT ON COLUMN public.profiles.phone_country_code IS 'Phone calling code (for example +1, +44) stored separately from local phone number.';

