# Application run outcome logging

**Last updated:** 2026-04-15  
**Tags:** jobbot, automation, queue-state, audit, artifacts

## Context

JobBot runs were writing local Playwright artifacts but were not persisting run lifecycle and artifact linkage back to the application record in Supabase.

## Facts / decisions

- Added DB fields on `public.applications` to track `automation_queue_state`, `automation_last_run_at`, `automation_last_outcome`, `automation_last_error`, and `automation_last_context`.
- Queue-state CHECK values (current): `queued`, `autofilling`, `waiting_for_human_action`, `human_action_completed`, `waiting_for_review`, `ready_to_submit`, `submitted`, `failed` (see `20260415100000_jobbot_execution_state_machine.sql`).
- Extended `public.application_events.event_type` constraint with `automation_status` for append-only lifecycle rows; finer phases use `metadata.lifecycle_phase` (e.g. `autofill_started`, `captcha_encountered`, `run_suspended_headless`).
- `automation/lib/outcomeLogger.ts` creates/updates `application_automation_sessions`, mirrors `run.log` lines into `run_log`, and **`syncSessionArtifacts`** merges full artifact path map into `metadata.artifact_paths` plus image paths into `screenshot_storage_paths` (local runner paths until an upload pipeline exists).
- Routine automation transitions **do not** overwrite `submission_status`; only explicit `submitted` automation outcome or user action should set it.
- When the user marks **Submitted** in Application Detail, `automation_queue_state` / `automation_last_outcome` update to `submitted`, an `automation_status` event is inserted, and the active session row gets `ended_at` if present.

## Sources

- `supabase/migrations/20260414170000_application_run_outcome_logging.sql`
- `supabase/migrations/20260415100000_jobbot_execution_state_machine.sql`
- `automation/application-form.spec.ts`
- `automation/lib/outcomeLogger.ts`
- `automation/lib/artifacts.ts`
- `src/pages/ApplicationDetail.tsx`
