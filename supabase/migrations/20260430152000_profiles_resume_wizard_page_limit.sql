alter table public.profiles
add column if not exists resume_wizard_page_limit integer not null default 1;

alter table public.profiles
drop constraint if exists profiles_resume_wizard_page_limit_check;

alter table public.profiles
add constraint profiles_resume_wizard_page_limit_check
check (resume_wizard_page_limit between 1 and 3);
