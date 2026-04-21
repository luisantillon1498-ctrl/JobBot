-- Create enum type for feature categories
create type public.resume_feature_type as enum (
  'professional_experience',
  'academics',
  'extracurriculars',
  'skills_and_certifications'
);

-- Main resume features table
create table public.resume_features (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  role_title text not null default '',
  company text not null default '',
  from_date date,
  to_date date,
  feature_type public.resume_feature_type not null default 'professional_experience',
  sort_order integer not null default 0,
  description_lines text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- RLS
alter table public.resume_features enable row level security;

create policy "Users can manage their own resume features"
  on public.resume_features
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Index for fast user queries ordered by type and sort_order
create index resume_features_user_type_order
  on public.resume_features (user_id, feature_type, sort_order);

-- Auto-update updated_at
create or replace function public.update_resume_features_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger resume_features_updated_at
  before update on public.resume_features
  for each row execute function public.update_resume_features_updated_at();
