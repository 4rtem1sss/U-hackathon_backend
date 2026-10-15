# Merge note

Merged using `frontend-merge-part3` x `part2/session_quotes` (branch `part2/sessions-quotes`).

This branch contains:
- `part3/backend-core` (person 3: DB, transfer states, idempotency, fiat sims, ntfy push)
- `part2/sessions-quotes` (person 2: demo sessions, recipients, quotes with simulated checks)
- `frontend-merge-part3` (person 1: CentMe frontend in `src/web/`, tests in `tests/web/`)

Ntfy: set `NTFY_TOPIC` (server) and `NEXT_PUBLIC_NTFY_TOPIC` (frontend) to the same long random topic. See `.env.example`.
Database: set `DATABASE_URL` to the Supabase Postgres connection string, then run the migrations in `db/migrations/`.
