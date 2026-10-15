# src/db

Server-only database layer (task T2). Import from `@/db`.

- `pool.ts`: lazy `getPool()` from `DATABASE_URL`; `createPool(url)` for tests/scripts.
  `numeric` and `int8` come back as strings (never JS floats).
- `tx.ts`: `withTransaction(fn, { isolationLevel?, pool? })` (BEGIN/COMMIT/ROLLBACK).
- `types.ts`: camelCase row types and status unions (mirror the SQL CHECK constraints).
- `errors.ts`: `StaleFenceError`, `isUniqueViolation(err, constraint?)`, `CONSTRAINTS` names.
- `repos/`: transfers (insert, reads, `updateTransferWithVersion`, `claimTransfer`,
  `releaseTransfer`, `assertFence`), events, idempotency, funding/payout attempts,
  quotes (accept), settlement attempts (read-only; part 4 writes them).

Schema: plain SQL in `db/migrations/`, applied by `pnpm db:migrate`
(`scripts/migrate.mjs`, recorded in `schema_migrations`). RLS is on for every table
with no policies: the API uses the server connection only.

DB tests: `eval "$(scripts/test-db.sh start)" && pnpm test:db`. They are skipped when
`DATABASE_URL` is unset, and also unless it points at localhost or `APP_MODE=test`
(so a real Supabase URL is never used). Each test file creates and drops its own database.
