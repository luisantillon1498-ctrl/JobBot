# JobBot non-negotiables

**Last updated:** 2026-04-14  
**Tags:** jobbot, constraints, safety, workflow

## Context

Persistent operating constraints for JobBot work to keep automation safe and production behavior consistent.

## Facts / decisions

- Never submit a job application without explicit user approval.
- Always save screenshots, logs, and extracted field mappings.
- Prefer small, targeted diffs.
- Do not refactor unrelated code.
- If a task is blocked, stop and report the blocker instead of guessing.
- Keep the application queue state machine consistent.
- Preserve existing working flows unless a task explicitly requires changing them.

## Sources

- User-provided operating constraints (2026-04-14).
