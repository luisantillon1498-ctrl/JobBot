-- Persist manual application queue controls for JobBot runs.
alter table public.applications
  add column if not exists automation_queue_priority integer not null default 0,
  add column if not exists automation_queue_excluded boolean not null default false;

-- Seed priorities in a stable order for existing rows (per user, newest first).
with ranked as (
  select
    id,
    row_number() over (partition by user_id order by created_at desc, id desc) as rn
  from public.applications
)
update public.applications a
set automation_queue_priority = ranked.rn
from ranked
where a.id = ranked.id
  and (a.automation_queue_priority is null or a.automation_queue_priority = 0);

create index if not exists applications_user_queue_priority_idx
  on public.applications (user_id, automation_queue_priority);
