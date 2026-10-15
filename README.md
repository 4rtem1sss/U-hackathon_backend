# U-hackathon_backend

Part 3 ("backend core") of the **US → TH P2P remittance demo**: a Next.js (App Router)
**API-only** app that owns the database schema, transfer state machine, idempotency,
the simulated USD funding and THB payout, and the `/advance` orchestrator that calls
part 4's Avalanche Fuji test-USDC settlement module.

The API follows `api-contract.md` v1 (team handoff). All responses use the envelopes:

```jsonc
// success
{ "data": { ... }, "meta": { "requestId": "req_…", "apiVersion": "v1", "replayed": false } }
// error
{ "error": { "code": "INVALID_INPUT", "message": "…", "retryable": false, "fieldErrors": {} },
  "meta": { "requestId": "req_…", "apiVersion": "v1" } }
```

> Status: scaffold (task T1). Only `GET /api/health` exists so far.

## Requirements

- Node 22 (`.nvmrc`), pnpm 10 (`packageManager` in `package.json`)
- PostgreSQL 16 for DB tests (local binaries or CI service; Docker not required)

## Commands

| Command | What it does |
| --- | --- |
| `pnpm install` | Install deps (CI uses `--frozen-lockfile`; commit `pnpm-lock.yaml`) |
| `pnpm dev` | Dev server on http://localhost:3000 |
| `pnpm build` / `pnpm start` | Production build / serve |
| `pnpm lint` | ESLint (Next.js flat config) |
| `pnpm typecheck` | `tsc --noEmit` (TypeScript strict) |
| `pnpm test` | Vitest unit tests (`tests/**/*.test.ts`) |

### Local Postgres for tests

`scripts/test-db.sh` starts a throwaway PostgreSQL 16 from the binaries in
`/usr/lib/postgresql/16/bin` (override with `PG_BIN`): `initdb` into a temp dir,
`pg_ctl start` on a free port on 127.0.0.1, creates database `p2p_test`, and prints
`DATABASE_URL`. When run as root it drops to `nobody` for the Postgres processes.

```sh
eval "$(scripts/test-db.sh start)"   # exports DATABASE_URL and TEST_DB_DIR
pnpm test
scripts/test-db.sh stop              # stop server and delete the temp dir
```

CI (`.github/workflows/ci.yml`) runs a `postgres:16` service instead and sets
`DATABASE_URL` for it; steps are install (frozen lockfile), lint, typecheck, test, build.

## Configuration

Copy `.env.example` to `.env.local`. Config is validated with zod in
`src/config/env.ts` and parsed lazily on first use (`getEnv()`), so `pnpm build`
works without env vars. All values are server-only: **never** use a `NEXT_PUBLIC_`
prefix for any of them.

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `APP_MODE` | no | `development` | `development` \| `test` \| `demo` \| `production` |
| `DATABASE_URL` | yes | – | `postgres://` / `postgresql://` (Supabase server connection in deploy) |
| `AVALANCHE_CHAIN_ID` | no | `43113` | Fuji C-Chain |
| `AVALANCHE_RPC_URL` | no | `https://api.avax-test.network/ext/bc/C/rpc` | Used only by part 4's module |
| `USDC_TOKEN_ADDRESS` | no | `0x5425890298aed601595a70AB815c96711a31Bc65` | Fuji test USDC |
| `DESTINATION_SETTLEMENT_ADDRESS` | yes | – | Allowlisted settlement destination (server config only) |
| `SETTLEMENT_PRIVATE_KEY` | with `SETTLEMENT_MODULE=fuji` | – | Dedicated Fuji test-only signer key (`0x` + 64 hex). Secret |
| `SETTLEMENT_MODULE` | explicit in demo/production | fake in dev/test | `fake` or persisted `fuji` implementation |
| `INTERNAL_RPC_SECRET` | no | – | Bearer secret if part 4 runs as a separate service (≥ 32 chars). Secret |
| `QUOTE_TTL_SECONDS` | no | `300` | Quote validity |
| `SETTLEMENT_CONFIRMATIONS` | no | `2` | Confirmations before a receipt counts as verified |
| `ALLOWED_ORIGINS` | no | empty | Comma list of extra origins allowed on mutations; the request's own host is always allowed |
| `NTFY_TOPIC` | no | empty | ntfy topic for the recipient push when a transfer completes; empty = notification `DISABLED`. ntfy.sh topics are public, so use a long random name |
| `NTFY_BASE_URL` | no | `https://ntfy.sh` | ntfy server |
| `NTFY_TOKEN` | no | empty | Bearer token for a protected ntfy topic |
| `NTFY_TIMEOUT_MS` | no | `3000` | Timeout for the push request |

## Layout

```
src/
  app/
    api/health/route.ts   GET /api/health -> { data: { status: "ok" } }
    layout.tsx, page.tsx  minimal root page (no UI)
  config/env.ts           zod-validated, lazily parsed server config
  lib/
    http.ts               ok(), errorResponse(), withHandler(), parseJsonBody(),
                          same-origin check, request ID context
    errors.ts             ApiError + error code table (api-contract §9)
    ids.ts                prefixed IDs (tr_<uuid>, qt_…, req_…)
    money.ts              strict unsigned integer amount strings <-> bigint
  domain/                 state machine, snapshot, simulators (T3, T5, T8)
  db/                     pg pool, transactions, repositories (T2)
  settlement/             frozen contract, fake module, persisted Fuji module
db/migrations/            plain SQL migrations (T2)
tests/                    vitest tests (unit/, later contract/ and db/)
scripts/test-db.sh        throwaway local Postgres 16
```

### Writing a route

```ts
import { getEnv } from "@/config/env";
import { ok, withHandler } from "@/lib/http";

export const POST = withHandler(
  async (req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return ok({ id }, { status: 202 });
  },
  { allowedOrigins: () => getEnv().ALLOWED_ORIGINS }, // same-origin check for mutations
);
```

Throw `new ApiError("INVALID_STATE")` (etc.) for expected failures; any other thrown
error becomes `500 INTERNAL_ERROR` with only the request ID (no stack or message).

## Try the full flow locally (no part 4 needed)

Settlement uses the in-memory fake module (`SETTLEMENT_MODULE=fake`), so no Fuji wallet is needed. Sessions and quotes come from a seed script until part 2's endpoints land.

```bash
eval "$(bash scripts/test-db.sh start | grep '^export')"   # local Postgres 16, prints DATABASE_URL
pnpm db:migrate
DESTINATION_SETTLEMENT_ADDRESS=0x1111111111111111111111111111111111111111 SETTLEMENT_MODULE=fake pnpm dev &

eval "$(node scripts/demo-seed.mjs)"                       # session cookie + USD 10.00 quote
SCENARIO=HAPPY_PATH bash scripts/demo-flow.sh              # or PAYOUT_FAILED / FUNDING_DECLINED
```

Each seeded quote can be used once; run `demo-seed.mjs` again for the next scenario. Use `pnpm test` with `DATABASE_URL` set to run the full test suite, including the DB and API tests.

## Recipient notification (ntfy)

Every snapshot has `notification: { channel: "NTFY", status, sentAt }`. Status is `NOT_STARTED` until the transfer reaches `COMPLETED_SIMULATED`. The `/advance` call that completes the transfer then sends one ntfy push from the server and records `SENT` (with `sentAt`) or `FAILED`; with no `NTFY_TOPIC` it records `DISABLED`. A failed push never blocks completion (`nextAction` stays `NONE`); any later `/advance` call retries it. Delivery is at-least-once: a crash between the push and the DB write can send it twice. The frontend shows "Recipient notified" when `notification.status === "SENT"`.
