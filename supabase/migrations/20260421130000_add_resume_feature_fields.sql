-- Add location, degree, and major fields to resume_features
alter table public.resume_features
  add column if not exists location text not null default '',
  add column if not exists degree text not null default '',
  add column if not exists major text not null default '';

-- Add 'personal' as a new enum value
alter type public.resume_feature_type add value if not exists 'personal';
