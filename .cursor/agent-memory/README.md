# Agent memory (shared context)

This folder is the **single source of truth** for durable context that should survive individual agent sessions.

## Layout

| Path | Purpose |
|------|---------|
| `index.json` | Registry of memory entries (id, title, path, timestamps, tags). |
| `entries/project-work-log.md` | Running timeline of recent work across all agents (read first). |
| `entries/*.md` | One file per topic; use `_template.md` as a starting shape. |

## Index entry shape

Each object in `index.json` → `entries`:

- `id` — stable kebab-case identifier (matches filename without `.md`).
- `title` — human-readable one line.
- `path` — relative to this folder, e.g. `entries/my-topic.md`.
- `updatedAt` — ISO 8601 UTC.
- `tags` — optional string array for discovery.

## Conventions

- Prefer **updating** an existing entry over spawning duplicates; merge facts.
- Keep entries **short**; link to code or docs instead of pasting large blocks.
- Do not store secrets, tokens, or personal data here.

## Required cross-agent log workflow

For every non-trivial task:

1. Read `index.json`.
2. Read `entries/project-work-log.md` and review recent entries.
3. Do the work.
4. Append one new entry to `entries/project-work-log.md` with:
   - goal
   - key changes
   - checks run
   - outcome
   - next step

This makes project direction visible to newly started agents without relying on chat-only context.
