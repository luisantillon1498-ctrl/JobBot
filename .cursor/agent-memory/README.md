# Agent memory (shared context)

This folder is the **single source of truth** for durable context that should survive individual agent sessions.

## Layout

| Path | Purpose |
|------|---------|
| `index.json` | Registry of memory entries (id, title, path, timestamps, tags). |
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
