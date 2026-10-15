# src/db

Database access (task T2): `pg` pool from `DATABASE_URL`, `withTransaction`,
typed repositories. Schema lives in plain SQL files under `db/migrations/`.
Server-only; the API uses the server connection only (RLS on, no anon access).
