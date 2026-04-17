# Project Work Log

**Purpose:** Running, cross-agent log of recent work and project direction.  
**Update cadence:** Add one entry after each meaningful task or decision.

## How to use

- Read the latest 3-10 entries at task start.
- If current work overlaps a recent entry, continue that thread instead of starting a new one.
- Append a new log entry when done (or when blocked).
- Keep entries concise and factual; include paths and commands where useful.

## Entry template

Use this exact structure for each new item:

```markdown
### YYYY-MM-DD HH:MM UTC — <agent/task title>
- **Goal:** <what this task tried to accomplish>
- **Changes:** <files touched, migrations, config, etc.>
- **Checks run:** <lint/tests/build or "not run">
- **Outcome:** <done, partial, blocked>
- **Next step:** <most useful follow-up for next agent>
```

---

### 2026-04-14 00:00 UTC — Shared memory bootstrap
- **Goal:** Create durable memory and cross-agent context handoff.
- **Changes:** Added `.cursor/agent-memory/*` and `.cursor/rules/agent-memory.mdc`; initialized this running log.
- **Checks run:** not run
- **Outcome:** done
- **Next step:** All future agents should read this file first and append one concise entry at task end.

### 2026-04-14 00:30 UTC — Submission status split
- **Goal:** Separate Draft/Submitted from stage progression and rename status semantics across app surfaces.
- **Changes:** Added migration `supabase/migrations/20260414143000_submission_status_and_application_stage.sql`; updated `src/integrations/supabase/types.ts` with `ApplicationSubmissionStatus` and `applications.submission_status`; updated `src/pages/ApplicationDetail.tsx`, `src/pages/Dashboard.tsx`, `src/pages/Analytics.tsx`, and `src/pages/NewApplication.tsx` to use submission status + application stage labels/UI; adjusted `supabase/functions/generate-cover-letter/index.ts` mappings for `not_started`.
- **Checks run:** `npx tsc --noEmit`; ReadLints on edited files.
- **Outcome:** done
- **Next step:** Apply the new migration in the target Supabase project before using the new Submission Status UI.

### 2026-04-14 12:49 UTC — Expand profile with job-application fields
- **Goal:** Add standard personal/application profile fields to Settings and persist them in Supabase `profiles`.
- **Changes:** Added migration `supabase/migrations/20260414123000_profiles_job_application_fields.sql` (first/last name, professional email, address fields, DOB, veteran/disability status, signup trigger update + backfill); updated `src/integrations/supabase/types.ts`; expanded `src/pages/Settings.tsx` load/save and UI form fields.
- **Checks run:** `npm run build`; `ReadLints` on `Settings.tsx` and `types.ts`
- **Outcome:** done
- **Next step:** Apply latest migration on the target Supabase project before using these new profile fields in production.

### 2026-04-14 12:55 UTC — Switch to first/middle/last name model
- **Goal:** Replace editable Full Name in Settings with first/middle/last fields while preserving compatibility for systems that still read `full_name`.
- **Changes:** Added migration `supabase/migrations/20260414131500_profiles_middle_name_and_full_name_sync.sql` (adds `middle_name`, backfills, updates `handle_new_user`); updated `src/integrations/supabase/types.ts` for `middle_name`; updated `src/pages/Settings.tsx` to remove Full Name input, add Middle Name input, and compose `full_name` from first/middle/last on save.
- **Checks run:** `npm run build`; `ReadLints` on `Settings.tsx` and `types.ts`
- **Outcome:** done
- **Next step:** Run migration `20260414131500_profiles_middle_name_and_full_name_sync.sql` in Supabase and reload app.

### 2026-04-14 00:00 UTC — Persist JobBot operating constraints
- **Goal:** Record non-negotiable safety and workflow constraints for JobBot tasks.
- **Changes:** Added `.cursor/agent-memory/entries/jobbot-non-negotiables.md` with approval, evidence retention, small-diff, blocker handling, queue consistency, and flow-preservation rules.
- **Checks run:** not run
- **Outcome:** partial (existing-file memory updates blocked by edit approval skip)
- **Next step:** Update `.cursor/agent-memory/index.json` to register the new memory entry and confirm future agents load it via index.

### 2026-04-14 09:43 UTC — QA review latest autofill run
- **Goal:** Audit newest autofill artifacts before user approval and flag submission risks.
- **Changes:** Reviewed `automation/output/2026-04-12T16-50-20-549Z/meta.json`, `payload.json`, and `before-submit.png`; compared with prior run outputs and current automation artifact expectations.
- **Checks run:** artifact inspection only (no code/test changes)
- **Outcome:** blocked for approval (run reached a Greenhouse "Page not found" view, no fields applied, uploads not verifiable, missing expected mapping/log artifacts)
- **Next step:** Browser Executor should rerun on a valid active job URL and produce complete artifacts (`meta`, `payload`, screenshots, field mappings, run log) for a fresh QA pass.

### 2026-04-14 09:56 UTC — Executor rerun attempt
- **Goal:** Execute autofill flow one more time and review fresh artifacts.
- **Changes:** Ran `npx playwright test automation/application-form.spec.ts --config automation/playwright.config.ts`; run skipped at startup due to missing `JOBPAL_JOB_URL` in environment; no new `automation/output/*` run directory created.
- **Checks run:** Playwright executor run (skipped)
- **Outcome:** blocked (missing runtime input)
- **Next step:** Set `JOBPAL_JOB_URL` (and payload env vars) in terminal/session, rerun executor, then perform QA on newly generated artifacts.

### 2026-04-14 13:35 UTC — Autofill field-mapping planner for Greenhouse
- **Goal:** Design and implement a robust, structured autofill field-mapping plan with normalization and ambiguity fallback.
- **Changes:** Updated `automation/lib/greenhouse.ts` to extract form fields, score/match aliases, build `mappingPlan` JSON, and fill only high-confidence matches; expanded `automation/types.ts` payload schema with LinkedIn/location/work auth/salary and cover-letter path fields; updated `automation/lib/artifacts.ts` env payload loading for new fields.
- **Checks run:** `npx tsc --noEmit`; `ReadLints` on edited automation files.
- **Outcome:** done
- **Next step:** Run a headed dry-run against at least one Greenhouse page and review `payload.json` `mappingPlan.issues` for ambiguous/low-confidence fields before enabling submit in any environment.

### 2026-04-14 00:00 UTC — Harden browser executor safety/artifacts
- **Goal:** Align Playwright browser executor with JobBot safety rules (no submit, artifact capture, blocker handling, site detection).
- **Changes:** Updated `automation/application-form.spec.ts` to detect site type, block unknown ATS, capture before/after screenshots + DOM snapshot, write field-mapping artifact, and always stop before final submit; expanded blocker detection in `automation/lib/blockers.ts` for 2FA and multi-step flows; enhanced fill logging + cover letter upload support in `automation/lib/greenhouse.ts`; added artifact paths and status/site typing in `automation/types.ts` and `automation/lib/artifacts.ts`.
- **Checks run:** `npx tsc --noEmit`; `ReadLints` on edited automation files.
- **Outcome:** done
- **Next step:** Run a headed Playwright trial with `JOBPAL_JOB_URL` and approved payload env vars to validate artifacts on a real Greenhouse posting.

### 2026-04-14 00:00 UTC — Executor integration defect fixes
- **Goal:** Apply minimal fixes from coordination review for queue-state timing, meaningful fill gating, and canonical mapping artifacts.
- **Changes:** Updated `automation/application-form.spec.ts` to remove `ready_to_submit` logging, end lifecycle at `waiting_for_review`, fail runs where no critical fields were applied, keep `site` metadata consistent across branches, and write both `mappingPlan` and `fieldMappings` to canonical `field-mappings.json`.
- **Checks run:** `npx tsc --noEmit`; `ReadLints` on `automation/application-form.spec.ts`.
- **Outcome:** done
- **Next step:** Execute one real Greenhouse run and confirm artifact consumers can parse updated `field-mappings.json` shape.

### 2026-04-14 13:44 UTC — Persist run outcomes to application history
- **Goal:** Make JobBot autofill/submission attempts auditable by logging run lifecycle, queue state, artifacts, and failure context on each application.
- **Changes:** Added migration `supabase/migrations/20260414170000_application_run_outcome_logging.sql` (new automation queue/outcome columns on `applications`, updated `application_events` constraint with `automation_status`); updated `src/integrations/supabase/types.ts`; added `automation/lib/outcomeLogger.ts`; updated `automation/application-form.spec.ts` and `automation/lib/artifacts.ts` to log lifecycle states and attach screenshot/field-mapping/log paths in event metadata.
- **Checks run:** `npm run build`; `npx tsc --noEmit`; `ReadLints` on edited files.
- **Outcome:** done
- **Next step:** Apply the new migration in Supabase and run one automation attempt with `JOBPAL_APPLICATION_ID`, `JOBPAL_USER_ID`, `JOBPAL_SUPABASE_URL`, and `JOBPAL_SUPABASE_SERVICE_ROLE_KEY` to verify DB-linked events/artifacts.

### 2026-04-14 14:10 UTC — Coordination audit across 4 autofill agents
- **Goal:** Evaluate end-to-end integration correctness across planner, executor, QA, and outcome logger outputs.
- **Changes:** Reviewed agent transcripts for Autofill Planner, Browser Executor, QA Agent, and Outcome Logger; verified current automation code paths in `automation/application-form.spec.ts`, `automation/lib/greenhouse.ts`, `automation/lib/artifacts.ts`, `automation/lib/outcomeLogger.ts`, and migration `supabase/migrations/20260414170000_application_run_outcome_logging.sql`.
- **Checks run:** code + transcript inspection only (no runtime execution)
- **Outcome:** partial (core pieces are present but review gating and run-state transitions are not fully wired correctly)
- **Next step:** Apply minimal integration fixes in executor state transitions, artifact handoff, and blocked/empty-fill handling, then rerun Browser Executor for fresh QA evidence.

### 2026-04-14 18:30 UTC — Add application queue page and persistence
- **Goal:** Create a minimal `Application Queue` page where users can rank, exclude, and save draft/ready-for-autofill applications.
- **Changes:** Added migration `supabase/migrations/20260414183000_application_queue_priority_and_exclusions.sql` to store `automation_queue_priority` + `automation_queue_excluded` on `applications`; updated `src/integrations/supabase/types.ts`; added `src/pages/ApplicationQueue.tsx`; wired route in `src/App.tsx`; added sidebar nav link in `src/components/AppLayout.tsx`.
- **Checks run:** `npm run build`; `ReadLints` on edited files.
- **Outcome:** done
- **Next step:** Connect queue retrieval (`/applications/queue`) to the Browser Executor trigger by selecting non-excluded items ordered by `automation_queue_priority`, then update each run's automation state/outcome via existing outcome logger.

### 2026-04-14 19:10 UTC — Split Application Queue into JobBot/User lanes
- **Goal:** Separate automation worklist from user review/approval work so users can edit docs while JobBot runs.
- **Changes:** Updated `src/pages/ApplicationQueue.tsx` to fetch broader automation states, split into `JobBot's Queue` and `User's Queue`, keep reorder/exclude/save scoped to JobBot lane, and keep app links in both sections routed to `/applications/:id`.
- **Checks run:** `ReadLints` on `ApplicationQueue.tsx`; `npm run build`.
- **Outcome:** done
- **Next step:** Optionally add quick actions in User Queue (e.g., "Open documents section" anchors) if users want one-click review workflows.

### 2026-04-14 14:22 UTC — Implement Start Applying queue handoff
- **Goal:** Wire the Application Queue "Start Applying" action to trigger server-side automation runs in saved queue order with status/event updates.
- **Changes:** Added Edge Function `supabase/functions/start-applying-queue/index.ts` to read non-excluded queue rows ordered by priority, assemble applicant/doc payloads, call automation runner (`JOBPAL_AUTOMATION_RUNNER_URL`) per application, enforce confidence/unknown-question policies in payload, and persist lifecycle states (`autofill_started`, `autofill_completed`, `waiting_for_review`, `blocked`, `failed`) plus `application_events`; added frontend helper `src/lib/startApplyingQueue.ts`; connected `src/pages/ApplicationQueue.tsx` Start Applying button to save pending queue edits, invoke the function, and refresh queue statuses.
- **Checks run:** `npm run build`; `ReadLints` on edited files.
- **Outcome:** done
- **Next step:** Deploy the new Edge Function and configure `JOBPAL_AUTOMATION_RUNNER_URL` (+ optional `JOBPAL_AUTOMATION_RUNNER_TOKEN`) in Supabase secrets so queue runs can reach the browser executor.

### 2026-04-14 14:38 UTC — Repair missing automation queue columns
- **Goal:** Fix runtime DB error `column applications.automation_queue_state does not exist` in environments where prior automation migrations were not applied.
- **Changes:** Added migration `supabase/migrations/20260414191000_automation_columns_repair.sql` to backfill missing automation columns (`automation_queue_state`, outcomes/context fields, queue priority/excluded), restore queue-state and event-type constraints, and normalize null/empty queue states.
- **Checks run:** not run (SQL migration file only)
- **Outcome:** done
- **Next step:** Run/deploy latest migrations on Supabase, then retry Application Queue `Start Applying`.

### 2026-04-14 14:48 UTC — Deploy start-applying-queue function
- **Goal:** Resolve frontend `failed to fetch` by verifying/deploying the queue handoff Edge Function.
- **Changes:** Confirmed local function exists at `supabase/functions/start-applying-queue`; verified project linkage to `sbpuxewnjxsaocixgmtq`; discovered function missing from deployed list; deployed function via `npx supabase functions deploy start-applying-queue` and redeployed with `--no-verify-jwt`; confirmed active deployment (`VERSION 2`) in `supabase functions list`.
- **Checks run:** `npx supabase functions list`; `npx supabase secrets list`
- **Outcome:** partial (connectivity fixed; runtime still requires queue runner secret configuration)
- **Next step:** Set `JOBPAL_AUTOMATION_RUNNER_URL` (and optional `JOBPAL_AUTOMATION_RUNNER_TOKEN`) in Supabase secrets, then retry `Start Applying`.

### 2026-04-14 14:53 UTC — Prevent submitted-status downgrade in queue handoff
- **Goal:** Fix regression where queue handoff could overwrite `submission_status='submitted'` back to `draft`.
- **Changes:** Updated `supabase/functions/start-applying-queue/index.ts` to exclude submitted applications from queue selection and remove forced `submission_status: 'draft'` updates; added update guard `.neq("submission_status", "submitted")`; redeployed function with `npx supabase functions deploy start-applying-queue --no-verify-jwt`.
- **Checks run:** Edge Function deploy command
- **Outcome:** done
- **Next step:** Restore any already-downgraded rows (if needed) and validate `Start Applying` no longer mutates submitted records.

### 2026-04-14 15:00 UTC — Queue fallback docs selection (default resume + auto cover)
- **Goal:** Ensure queue runs can proceed when submission documents are not explicitly selected.
- **Changes:** Updated `supabase/functions/start-applying-queue/index.ts` to: (1) use `profiles.default_resume_document_id` when `submitted_resume_document_id` is empty and persist that fallback; (2) resolve cover fallback in order: linked cover doc on application, latest generated cover artifact saved into `documents` + `application_documents`, and finally auto-call `generate-cover-letter` then save/link resulting artifact as a cover document; (3) pass fallback doc ids/signed URLs to runner payload; redeployed function.
- **Checks run:** `npx supabase functions deploy start-applying-queue --no-verify-jwt`
- **Outcome:** done
- **Next step:** Validate end-to-end on an app with no selected resume and no selected cover to confirm default resume + generated cover are attached and used during queue handoff.

### 2026-04-14 15:18 UTC — Treat runner connectivity as hard blocker
- **Goal:** Prevent queue from failing every item when the external automation runner is unreachable.
- **Changes:** Updated `supabase/functions/start-applying-queue/index.ts` so runner fetch/network failures are logged as `blocked` with `hard_blocker: true`, and queue processing stops after first item instead of continuing to fail all queued apps; redeployed function.
- **Checks run:** `npx supabase functions deploy start-applying-queue --no-verify-jwt`
- **Outcome:** done
- **Next step:** Confirm runner URL/token is valid and publicly reachable from Supabase Edge runtime; rerun queue and verify only one blocked item appears when runner is down.

### 2026-04-14 15:35 UTC — Confirm missing deployed runner service
- **Goal:** Diagnose why all queue items fail despite queue orchestration/function fixes.
- **Changes:** Verified DB errors show `Invalid URL: 'https://<your-runner-endpoint>'` in `automation_last_error`; confirmed `start-applying-queue` is deployed and active; confirmed project lacks any deployed browser-runner HTTP service/config in repo (no server app / Dockerfile / deployment config), so `JOBPAL_AUTOMATION_RUNNER_URL` currently points to placeholder.
- **Checks run:** repo scan for runner/deployment files; Supabase functions status and prior DB telemetry queries.
- **Outcome:** blocked (missing runner service + real runner URL secret)
- **Next step:** Implement and deploy a minimal runner service endpoint that executes existing Playwright automation, then set `JOBPAL_AUTOMATION_RUNNER_URL` (+ optional token) in Supabase secrets and validate queue end-to-end.

### 2026-04-14 15:06 UTC — Add separate phone country code field
- **Goal:** Split calling code from local phone number in profile settings.
- **Changes:** Added migration `supabase/migrations/20260414193000_profiles_phone_country_code.sql` (`profiles.phone_country_code`); updated `src/integrations/supabase/types.ts`; updated `src/pages/Settings.tsx` to load/save `phone_country_code` and render separate Country code + Phone inputs.
- **Checks run:** `npm run build`; `ReadLints` on `Settings.tsx` and `types.ts`
- **Outcome:** done
- **Next step:** Run migration `20260414193000_profiles_phone_country_code.sql` in Supabase and reload app.

### 2026-04-14 15:11 UTC — Fix Settings profile reload error after save
- **Goal:** Resolve "Could not load your profile" surfaced after saving Settings.
- **Changes:** Updated `src/pages/Settings.tsx` profile fetch to `select("*")` to avoid hard-failing on partially migrated profile columns; added schema-aware save error message using `isMissingProfilesColumnError`; expanded schema hint helpers in `src/lib/supabaseSchemaHints.ts`.
- **Checks run:** `npm run build`; `ReadLints` on `Settings.tsx` and `supabaseSchemaHints.ts`
- **Outcome:** done
- **Next step:** If save still errors, apply any missing profile migrations (especially latest `profiles_*`) and retry after schema cache refresh.

### 2026-04-14 15:14 UTC — Handle missing cover_letter_tone schema safely
- **Goal:** Prevent Settings tone-save errors when `profiles.cover_letter_tone` is not yet present in Supabase schema cache.
- **Changes:** Added `isMissingCoverLetterToneColumnError` in `src/lib/supabaseSchemaHints.ts`; updated `src/pages/Settings.tsx` to detect missing tone column, show actionable migration toast, and hide/disable tone controls with an inline migration hint until schema is updated.
- **Checks run:** `npm run build`; `ReadLints` on `Settings.tsx` and `supabaseSchemaHints.ts`
- **Outcome:** done
- **Next step:** Run migration `20260413140000_profiles_cover_letter_tone.sql` in Supabase, wait for schema cache refresh, then reload Settings.

### 2026-04-14 20:20 UTC — Cover letter Gemini overload fallback hardening
- **Goal:** Resolve intermittent Gemini "high demand" failures for single cover-letter requests by treating provider overload as transient and falling back when possible.
- **Changes:** Updated `supabase/functions/generate-cover-letter/index.ts` to detect transient overload statuses/messages (429/500/503/504 + high-demand wording), retry Gemini with backoff on overload, and automatically fall back to OpenAI-compatible generation when `OPENAI_API_KEY` is available; bumped `COVER_LETTER_GENERATOR_VERSION` to `cover-letter.9`; redeployed function to project `sbpuxewnjxsaocixgmtq`.
- **Checks run:** `npx supabase functions deploy generate-cover-letter`; `ReadLints` on function file.
- **Outcome:** done
- **Next step:** If overload persists, set `OPENAI_API_KEY` as fallback secret and optionally switch `GEMINI_MODEL` to `gemini-2.5-flash-lite` for better availability.

### 2026-04-14 20:40 UTC — Editable cover letter versions + feedback-informed generation
- **Goal:** Let users directly edit generated cover letters, save new versions, and feed wording/structure feedback into future generation.
- **Changes:** Updated `src/pages/ApplicationDetail.tsx` to add inline editor UI on cover-letter artifacts, capture optional feedback notes, and save edited text as a new `generated_artifacts` row (`generator_version: user-edit.1`) plus a timeline event; updated `supabase/functions/generate-cover-letter/index.ts` to parse feedback from user-edited artifact `prompt_used`, inject deduped feedback bullets into the generation prompt, include feedback in deterministic seed material, and bump generator version to `cover-letter.10`; redeployed function.
- **Checks run:** `ReadLints` on edited files; `npx supabase functions deploy generate-cover-letter`.
- **Outcome:** done
- **Next step:** QA the end-to-end loop: edit/save cover letter with feedback, generate a new one, and verify the new output reflects feedback constraints.

### 2026-04-14 20:45 UTC — Cross-agent memory coverage audit
- **Goal:** Verify that shared memory reflects latest multi-agent project work and identify handoff gaps.
- **Changes:** Audited `git status --short`, `git diff --stat`, and this project log; confirmed broad feature/migration work is logged, but recent edits to `.cursor/agent-memory/README.md`, `src/components/ui/command.tsx`, `src/components/ui/textarea.tsx`, `src/lib/jobExtraction.ts`, `supabase/functions/parse-job-url/index.ts`, and `tailwind.config.ts` are not explicitly captured yet; found duplicate constraints note file (`jobbot-non-negotiables.md` vs `jobbot-operating-constraints.md`).
- **Checks run:** `git status --short`; `git diff --stat`; coverage comparison script between changed files and log references.
- **Outcome:** partial (core trajectory is captured, but latest file-level deltas and one duplicate memory entry need cleanup).
- **Next step:** Add a focused log entry summarizing the intent of the unlogged UI/parser/theme tweaks and consolidate to one canonical JobBot constraints memory file.

### 2026-04-14 20:55 UTC — Log untracked intent and dedupe constraints memory
- **Goal:** Complete memory cleanup by documenting remaining unlogged edits and consolidating duplicate constraints notes.
- **Changes:** Documented that remaining unlogged code deltas are implementation-neutral cleanup: `src/components/ui/command.tsx` and `src/components/ui/textarea.tsx` switched empty `interface` declarations to `type` aliases; `src/lib/jobExtraction.ts` and `supabase/functions/parse-job-url/index.ts` replaced unnecessary mutable bindings with `const` and normalized a title separator regex; `tailwind.config.ts` moved Tailwind animate plugin loading from `require(...)` to typed import (`tailwindcssAnimate`); removed duplicate `.cursor/agent-memory/entries/jobbot-operating-constraints.md` in favor of canonical `jobbot-non-negotiables.md`.
- **Checks run:** `git diff -- <files>` for the unlogged set; memory entry comparison.
- **Outcome:** done
- **Next step:** Continue using `project-work-log.md` as required handoff, and keep only one canonical constraints entry per topic to avoid split context.

### 2026-04-14 22:30 UTC — Deploy Playwright automation runner (Railway) + Supabase secrets
- **Goal:** Ship a public HTTPS `POST /run` service so `start-applying-queue` can execute queued applications; validate edge reachability and runner responses.
- **Changes:** Added `automation/runner/server.mjs` (HTTP runner wrapping existing Playwright spec), `automation/runner/Dockerfile` (Playwright base `v1.59.1-jammy`), root `railway.json`, `package.json` script `runner:start`; deployed Railway project `jobpal-automation-runner` / service `runner` with domain `https://runner-production-9d18.up.railway.app`; set Supabase secrets `JOBPAL_AUTOMATION_RUNNER_URL` (…`/run`) and `JOBPAL_AUTOMATION_RUNNER_TOKEN`; added and deployed `supabase/functions/check-automation-runner` for edge-to-runner health probe; tuned runner mapping for Playwright skips → `blocked` and narrowed `unanswered_questions` to ambiguous/low-confidence work_authorization only.
- **Checks run:** `curl` `/healthz` and `/run` against Railway; `POST …/functions/v1/check-automation-runner` (edge OK); remote `/run` with `job_url=https://example.com` → `status: blocked`; sample Greenhouse listing URLs returned blocked/eligibility pause (listing URLs often `?error=true`).
- **Outcome:** partial (infra + secrets + edge reachability done; full 3-app queue UI validation and a clean `waiting_for_review` success on a live application form URL still need user-run confirmation).
- **Next step:** In app, queue 3 apps with distinct priorities, click Start Applying, then confirm `applications` + `application_events` order; use a direct Greenhouse **application** URL (embed/form), not a dead listing, for one success path. Rotate runner token if it was exposed in chat logs.

### 2026-04-14 23:10 UTC — Multi-ATS autofill modules (Greenhouse, Workday, Ashby)
- **Goal:** Add ATS-specific coverage beyond Greenhouse: Workday and Ashby share the same high-confidence mapping pipeline with site-tuned patterns.
- **Changes:** Added `automation/lib/atsFormFill.ts` (shared extract/score/fill + `data-automation-id`/title signals); refactored `automation/lib/greenhouse.ts` to delegate to shared fill; added `automation/lib/workday.ts`, `automation/lib/ashby.ts`, `automation/lib/siteDetection.ts`; extended `automation/types.ts` `SiteType`; updated `automation/application-form.spec.ts` routing; updated `supabase/functions/start-applying-queue/index.ts` `ats_target` from `job_url` via `atsTargetFromJobUrl`; noted ATS list in `automation/runner/README.md`.
- **Checks run:** `npx tsc --noEmit`; `ReadLints` on touched files.
- **Outcome:** done (v1: same engine, site-specific pattern/id hints; Workday shadow-only UIs may still block until deeper handling).
- **Next step:** Redeploy `start-applying-queue` for live `ats_target` metadata; optionally tune Workday/Ashby patterns from real form captures.

### 2026-04-15 00:05 UTC — Queue page drives selective sequential runs + human handoff UI
- **Goal:** Wire Application Queue to run only non-excluded ordered rows, refresh status per item, surface captcha/human pause, and resume after user action.
- **Changes:** `supabase/functions/start-applying-queue/index.ts` parses JSON `application_ids` + `resume`, builds queue in client order, adds `handoff_category` in event context; `src/lib/startApplyingQueue.ts` sends body + `startApplyingQueueSequential`; `src/pages/ApplicationQueue.tsx` sequential Start Applying, Resume queue, human-action Alert, Loader on active row, expanded status labels and fetch fields (`job_url`, `automation_last_error`, `automation_last_context`).
- **Checks run:** `npx tsc --noEmit`; `npx supabase functions deploy start-applying-queue --no-verify-jwt`.
- **Outcome:** done
- **Next step:** Captcha resume from server runner may re-prompt (new browser session); long-term needs attended browser or manual complete + state skip.

### 2026-04-14 22:45 UTC — Start Applying when only User queue has rows
- **Goal:** Fix misleading “no applications selected” when all visible work sits under User’s Queue after the JobBot/User split.
- **Changes:** Updated `src/pages/ApplicationQueue.tsx` to only block Start Applying when JobBot’s table rows are all excluded; allow handoff when User’s Queue has items (matches `start-applying-queue` DB selection); fixed down-arrow `disabled` bug (`rows` → `jobBotRows`); clarified empty JobBot copy when User’s Queue is non-empty.
- **Checks run:** `ReadLints` on `ApplicationQueue.tsx`; `npm run build`.
- **Outcome:** done
- **Next step:** Optional UX: duplicate user-review rows into JobBot’s table for explicit exclude/reorder, or add “Re-queue after review” state transition from application detail.

### 2026-04-14 23:45 UTC — Human-handoff lifecycle logging + session artifacts
- **Goal:** Persist captcha pauses, human completion, review, and submission readiness without changing browser behavior or queue UI.
- **Changes:** Reworked `automation/lib/outcomeLogger.ts` to align with `applications.automation_queue_state` (queued/autofilling/waiting_for_human_action/human_action_completed/waiting_for_review/ready_to_submit/submitted/failed), create/update `application_automation_sessions` (run_log, handoff timestamps, artifact path metadata, `automation_active_session_id`), append-only `logLifecycle` phases (`autofill_started`, `captcha_encountered`, `autofill_completed`, `run_suspended_headless`), sync `submission_status` with non-terminal automation states; updated `automation/application-form.spec.ts` for human verification + blocker handoffs (not failures), post-review `human_action_completed` + `ready_to_submit`, and `appendLocalAndSession` for run.log + session mirror.
- **Checks run:** `ReadLints` on edited automation files.
- **Outcome:** done
- **Next step:** Runner should pass `JOBPAL_AUTOMATION_SESSION_ID` when resuming the same session; optional upload of screenshot bytes to `documents` storage and populate `screenshot_storage_paths` with bucket keys instead of local paths only.

### 2026-04-15 00:00 UTC — Captcha human-in-the-loop browser handoff
- **Goal:** On captcha/bot-check, pause safely, save artifacts, set `waiting_for_human_action`, resume same Playwright session after user completes verification (no bypass, no auto-submit).
- **Changes:** Added `automation/lib/humanChallenge.ts` (main-document detection + copy cues), `automation/lib/humanHandoff.ts` (handoff JSON, screenshots, DOM, poll + optional `JOBPAL_HUMAN_ACTION_DONE_FILE`); removed captcha from `detectBlockers` in `automation/lib/blockers.ts`; integrated handoff + resume in `automation/application-form.spec.ts`; extended `automation/types.ts` `RunStatus` and runner `server.mjs` mapping/artifacts; `supabase/functions/start-applying-queue` maps runner `waiting_for_human_action`; `src/pages/ApplicationQueue.tsx` labels/legacy state filters.
- **Checks run:** `npx tsc --noEmit`; `ReadLints` on touched files.
- **Outcome:** done
- **Next step:** Document `JOBPAL_HUMAN_CHALLENGE_TIMEOUT_MS` / `JOBPAL_HUMAN_ACTION_DONE_FILE` in runner README; for queue re-runs after headless suspend, run headed locally or wire `JOBPAL_AUTOMATION_SESSION_ID` resume when product supports split runs.

### 2026-04-15 05:00 UTC — Session artifact persistence + submitted queue alignment
- **Goal:** Keep `application_automation_sessions` metadata in sync with screenshots, run log, DOM snapshot, and field mappings; align `automation_queue_state` when the user marks submitted; treat pauses as non-terminal sessions.
- **Changes:** Added `syncSessionArtifacts` in `automation/lib/outcomeLogger.ts` (merge `metadata.artifact_paths`, extend `screenshot_storage_paths` for PNGs including extras such as blocked/error shots); stopped setting `ended_at` on `ready_to_submit`; stopped forcing `submission_status` to `draft` on routine automation transitions; extended `LifecyclePhase` union for documentation parity; wired `syncSessionArtifacts` calls and blocker `waiting_for_human_action` lifecycle row in `automation/application-form.spec.ts`; updated `src/pages/ApplicationDetail.tsx` `updateSubmissionStatus` to set automation columns to `submitted`, insert `automation_status` event, and set session `ended_at` when applicable.
- **Checks run:** `npx tsc --noEmit`; `ReadLints` on touched files.
- **Outcome:** done
- **Next step:** Optional migration only if product wants true Storage URIs in `screenshot_storage_paths` instead of runner-local paths in JSON.

### 2026-04-15 01:35 UTC — Remove Lovable remnants + clean lockfiles
- **Goal:** Eliminate remaining Lovable references (including lockfile tarball URLs) after prior code/README/vite/playwright cleanup.
- **Changes:** Ran `npm install` to refresh `package-lock.json` (drops `lovable-tagger` subtree); removed legacy text `bun.lock` with embedded `lovable-core-prod` URLs; ran `npx bun@1.2.5 install` to generate fresh `bun.lockb` from public registry (no `lovable` substring in lockfile).
- **Checks run:** repo grep for `lovable`/`Lovable` (no matches); `Select-String` on `bun.lockb` for `lovable` (0); `npm run build` (success).
- **Outcome:** done
- **Next step:** If the team standardizes on npm only, consider dropping `bun.lockb` or documenting Bun version; note fresh Bun resolve may have bumped deps within existing semver ranges in `package.json`.

### 2026-04-15 12:00 UTC — Runner env handoff for Playwright outcome logger
- **Goal:** Pass `application_id` / `user_id` into Playwright and inherit host env so `outcomeLogger` can reach Supabase.
- **Changes:** `automation/runner/server.mjs` — added `JOBPAL_APPLICATION_ID` and `JOBPAL_USER_ID` to the `env` object passed to `runPlaywright` (child env remains `{ ...process.env, ...env }`).
- **Checks run:** not run
- **Outcome:** done
- **Next step:** Ensure Railway (or other runner host) sets `JOBPAL_SUPABASE_URL` and `JOBPAL_SUPABASE_SERVICE_ROLE_KEY`; confirm `start-applying-queue` payload includes `application_id` and `user_id`.

### 2026-04-15 14:00 UTC — Queue / executor / logger lifecycle audit (post runner env)
- **Goal:** Align JobBot queue states with executor + outcome logger; no `ready_to_submit` before in-app review; document canonical transitions; harden session creation.
- **Changes:** `automation/application-form.spec.ts` — terminal automation DB state after success is `waiting_for_review` only (removed post-review `ready_to_submit` / headed pause state writes); `automation/lib/outcomeLogger.ts` — doc comment on canonical lifecycle + `ensureSession` guard if ids missing; `src/lib/startApplyingQueue.ts` — outcome state doc comment; `supabase/functions/start-applying-queue/index.ts` — comment on `QueueState` alignment; `src/pages/ApplicationQueue.tsx` — rename `READY_TO_SUBMIT_QUEUE_STATE`; `src/pages/ApplicationDetail.tsx` — alert + “Mark ready to submit” after review (`waiting_for_review` → `ready_to_submit` + `automation_status` event).
- **Checks run:** `npx tsc --noEmit`; `ReadLints` on touched files.
- **Outcome:** done
- **Next step:** QA: queue run ends in User queue as “Waiting for review”; after “Mark ready to submit” on detail, row moves to ready state; Resume queue still targets `waiting_for_human_action` only.

### 2026-04-15 15:30 UTC — Live interactive browser (human captcha) plan
- **Goal:** Document multi-agent rollout for embedded remote-browser live view (browser-only UX).
- **Changes:** In-chat orchestration guide for Cursor agents; no code yet.
- **Checks run:** not run
- **Outcome:** done (planning)
- **Next step:** ~~pick vendor vs self-hosted~~ **Vendor** chosen; run Agent B with hosted-browser + embed/live URL pattern.

### 2026-04-15 17:30 UTC — ADR sketch: interactive live session API
- **Goal:** Lock minimal runner/Edge JSON contract for vendor-hosted live view (single browser through human handoff) without exposing CDP or runner token to clients.
- **Changes:** In-chat ADR only (`POST /sessions` + Edge mint, `cdp_ws_url` server-only, `viewer_*` + `vendor_session_id` + `expires_at`, dual timeouts `JOBPAL_RUN_TIMEOUT_MS` vs `JOBPAL_HUMAN_CHALLENGE_TIMEOUT_MS`, DB/event fields on viewer-ready vs human-complete).
- **Checks run:** not run
- **Outcome:** done (design handoff for Agent B)
- **Next step:** Agent B implements runner `/sessions`, Edge `automation-live-session`, and DB writes per sketch.

### 2026-04-15 16:00 UTC — Live view streaming: vendor path
- **Goal:** Lock implementation lane for interactive remote browser.
- **Changes:** Decision only (Browserbase-class API: create session, Playwright `connectOverCDP`, embed/debug URL for user).
- **Checks run:** not run
- **Outcome:** done
- **Next step:** Implement runner + Edge mint against chosen vendor account and API keys in Railway/Supabase secrets.

### 2026-04-15 16:30 UTC — Hosted browser vendor choice
- **Goal:** Pick vendor for live view + Playwright CDP.
- **Changes:** **Browserbase** recommended (session live view, iframe embed, `connectOverCDP`, `@browserbasehq/sdk`); Steel noted as alternative.
- **Checks run:** vendor docs review (Browserbase session live view + Playwright intro)
- **Outcome:** done
- **Next step:** User completes Browserbase signup; add `BROWSERBASE_API_KEY` (+ project id if required by API) to Railway runner secrets; Agent B implements SDK session create + `bb.sessions.debug` for embed URL.
