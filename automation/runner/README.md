# JobPal Automation Runner

Minimal HTTP service that executes one Playwright autofill run per request.

Autofill targets (URL-based): **Greenhouse** (`*.greenhouse.io`), **Workday** (`*.myworkdayjobs.com` and related), **Ashby** (`*.ashbyhq.com`). Other hosts return `blocked` (unknown site).

## Endpoint contract

- `POST /run`
  - Auth: optional bearer token (`JOBPAL_AUTOMATION_RUNNER_TOKEN`).
  - Request: payload emitted by `supabase/functions/start-applying-queue`.
  - Response fields:
    - `status`: `waiting_for_review` | `blocked` | `failed`
    - `hard_blocker`: boolean
    - `unanswered_questions`: array (present for question-based pauses)
    - `artifacts`: run metadata and file paths
    - `final_url`: final browser URL
    - `message` / `error`: details for queue event logging

- `GET /healthz`
  - Basic health probe.

## Local run

```bash
npm run runner:start
```

## Railway deploy

```bash
npx @railway/cli up
```

Set env vars in Railway:

- `JOBPAL_AUTOMATION_RUNNER_TOKEN` (optional but recommended)
- `JOBPAL_RUN_TIMEOUT_MS` (optional; defaults to 180000)
