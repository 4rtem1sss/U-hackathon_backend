# Settlement contract (part 3 ↔ part 4)

> **สรุปภาษาไทย:** ส่วนที่ 3 (backend) เรียก `SettlementModule.step(intent, fence)` ของส่วนที่ 4 ทีละขั้น (ไม่เกิน ~10 วินาที) ส่วนที่ 4 เขียนได้เฉพาะตาราง `settlement_attempts` และต้องบันทึก signed tx + hash + nonce ลง DB **ก่อน** broadcast เสมอ
> ถ้า timeout หรือ response หาย ห้ามสร้าง nonce/การจ่ายใหม่ ให้ตาม hash เดิมต่อ และต้องเช็ก fence ภายใน transaction ที่เขียน attempt ทุกครั้ง
> ผลลัพธ์ห้ามมี signed bytes หรือ private key ก่อนส่งงานให้รัน contract test suite (`tests/contract/settlement.contract.ts`) กับ module จริงให้ผ่าน

Source of truth: [`src/settlement/contract.ts`](../src/settlement/contract.ts) (plan §4). Change it only when parts 3 and 4 both agree.

## Interface

```ts
interface SettlementIntent { transferId; chainId: 43113; tokenAddress; destination; units /* integer string */ }
interface Fence { transferId; epoch /* transfers.claim_epoch */ }

type SettlementResult =
  | { kind: "NOT_SUBMITTED"; attemptId: string | null; issue?: Issue }
  | { kind: "PENDING"; attemptId; txHash; phase: "BROADCAST" | "PENDING"; issue?: Issue }
  | { kind: "CONFIRMED"; attemptId; txHash; evidence: Evidence }
  | { kind: "FAILED"; attemptId; txHash; reason }          // known on-chain revert only
  | { kind: "REVIEW"; attemptId: string | null; txHash: string | null; reason };

interface SettlementModule {
  step(intent: SettlementIntent, fence: Fence): Promise<SettlementResult>; // bounded, idempotent
  getAttempt(transferId: string): Promise<AttemptView | null>;            // read-only, no RPC
  preflight(): Promise<{ ok: boolean; issues: Issue[] }>;                  // chain id, token, balances
}

interface FenceGuard<Tx = unknown> { assertFence(fence: Fence, tx?: Tx): Promise<void> } // throws StaleFenceError
```

Part 3 builds the intent with `buildSettlementIntent()` (chain, token and destination from server config; units from the accepted quote). Part 3 gives your module a `FenceGuard` through its constructor/factory. Wire your module in `getSettlementModule()` (`src/settlement/index.ts`, branch `SETTLEMENT_MODULE=fuji`).

## Who writes what

| Table | Written by |
| --- | --- |
| `transfers`, `transfer_events`, `funding_attempts`, `payout_attempts`, `idempotency_keys` | part 3 only |
| `settlement_attempts` | **part 4 only** |

Part 4 never marks a transfer settled; it returns evidence. Part 3 never signs, broadcasts or calls the chain.

## `settlement_attempts` columns

| Column | Notes |
| --- | --- |
| `id` | text, `stl_…` |
| `transfer_id` | text → transfers.id |
| `chain_id` | integer (43113) |
| `token_address` | text |
| `signer` | text (sender address) |
| `destination` | text |
| `units` | numeric(38,0) |
| `nonce` | bigint |
| `signed_tx` | text, **never leaves the module** |
| `tx_hash` | text |
| `phase` | `PREPARED` \| `BROADCAST` \| `PENDING` \| `CONFIRMED` \| `FAILED` \| `REVIEW` |
| `receipt_block_number` | numeric/bigint, null until mined |
| `receipt_block_hash` | text, null until mined |
| `evidence` | jsonb (`Evidence`), set on CONFIRMED |
| `created_fence` | integer (claim epoch that created the row) |
| `created_at`, `updated_at` | timestamptz |

Constraints: `unique(chain_id, signer, nonce)`, `unique(chain_id, tx_hash)`, and one unresolved attempt per signer (partial unique index on `signer` where `phase in ('PREPARED','BROADCAST','PENDING')`). The migration itself is part 3's (task T2), drafted together with you.

## Step sequence (one bounded call, < ~10 s)

1. Load the latest attempt for `intent.transferId`.
   - Exists and terminal → return the same result again (idempotent).
   - Exists but differs from the intent (token/destination/units/chain) → `REVIEW`, never re-send.
2. No attempt → in **one DB transaction**: `assertFence(fence, tx)` (row lock on the transfer), reserve the nonce, sign, insert the row with `signed_tx`, `tx_hash`, `nonce`, `phase=PREPARED`, `created_fence`. Commit. You may return `NOT_SUBMITTED` here or continue.
3. Phase `PREPARED` → broadcast the **stored** bytes (same hash every time). Then in a short transaction: `assertFence` + set `phase=BROADCAST`. Return `PENDING/BROADCAST`.
4. Phase `BROADCAST`/`PENDING` → query the receipt for the stored hash:
   - not found / RPC slow → `PENDING` (re-broadcasting the same stored bytes is fine; a new nonce is not);
   - status 0 → `FAILED`;
   - success → verify chain, token contract, sender, destination, exact `Transfer` amount, confirmations → write `receipt_block_*`, `evidence`, `phase=CONFIRMED` (with `assertFence`) → `CONFIRMED`;
   - anything inconsistent → `REVIEW`.
5. Throw for "dependency unavailable, nothing decided". Throw `StaleFenceError` (from `assertFence`) when the fence is stale; never write after that.

Never: hold a DB transaction open across an RPC wait; make a new nonce/payment because of a timeout or lost response; put signed bytes or keys in a result, error message or log.

## How part 3 maps the result (plan §4.3)

| Result | Transfer status | `settlement` substatus | Other effect (same DB tx) |
| --- | --- | --- | --- |
| NOT_SUBMITTED | SETTLEMENT_PENDING | PREPARING | set `lastIssue` if any |
| PENDING | SETTLEMENT_PENDING | BROADCAST / PENDING | store txHash for snapshot |
| CONFIRMED | SETTLED | CONFIRMED | store evidence, create payout attempt #1 (stable request ID) |
| FAILED | SETTLEMENT_FAILED | FAILED | keep hash, payout NOT_STARTED |
| REVIEW | REVIEW_REQUIRED | REVIEW_REQUIRED | hold; nextAction NONE |
| thrown error / RPC down | unchanged | unchanged | `lastIssue = DEPENDENCY_UNAVAILABLE`, release claim |

## Running the contract suite against your module

`tests/contract/settlement.contract.ts` exports `runSettlementContractSuite(name, factory)`. Create e.g. `tests/contract/fuji.contract.test.ts`:

```ts
import { runSettlementContractSuite } from "./settlement.contract";

runSettlementContractSuite("Fuji module (local chain)", async () => ({
  module,                                   // your SettlementModule, wired to a DB FenceGuard
  newTransfer: async () => ({ intent, fence }),  // insert + claim a transfer row, build the intent
  makeStale: async (fence) => newFence,     // bump transfers.claim_epoch
  countAttempts: async (id) => ({ attempts, hashes }), // SELECT from settlement_attempts
  failNextStep, loseNextBroadcastResponse, scriptRevert, // optional fault hooks (skipped if absent)
  stepIntervalMs: 500, maxSteps: 40,
  cleanup,
}));
```

It checks: repeated steps never create a second attempt/hash; concurrent steps create at most one; after a thrown or lost-response step the next step returns the same hash; a stale fence throws `StaleFenceError` and writes nothing; CONFIRMED evidence `chainId/units/to/tokenAddress` equal the intent; `getAttempt` has no side effects; no result/view/preflight contains `signedTx`/`rawTransaction`/`privateKey` keys or a `0x` string longer than 66 chars. `tests/contract/fake.contract.test.ts` runs it against the fake: `pnpm vitest run tests/contract`.

## Fake module

`FakeSettlementModule` (`src/settlement/fake.ts`) is in-memory and scriptable per transfer (`confirmAfter(n)`, `revert`, `review`, `throwOnce`, `lostResponse`, `prepareFirst`). It creates deterministic fake hashes and **never touches a chain**. It refuses to run when `APP_MODE` is `demo`/`production` unless `SETTLEMENT_MODULE=fake` is set. Its state is per process (lost on restart, per instance on Vercel).

## Optional HTTP form

`POST /api/internal/settlement/step`, body `{ intent, fence }`, header `Authorization: Bearer $INTERNAL_RPC_SECRET`; 404 when the secret is unset. Returns the `SettlementResult` in the standard `{ data, meta }` envelope; stale fence → 409 `INVALID_STATE`; thrown step → 503 `DEPENDENCY_UNAVAILABLE`. Use only if part 4 runs as a separate service.
