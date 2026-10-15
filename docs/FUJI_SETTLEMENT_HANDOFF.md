# Avalanche Fuji Settlement Integration Handoff

## 1. Overview

Part 4 implements the real blockchain settlement leg behind the backend's existing `SettlementModule` contract. It sends Circle Test USDC from a dedicated server-controlled test wallet to one configured destination wallet on the Avalanche Fuji C-Chain.

Avalanche Fuji is used because it provides an EVM-compatible test network where the team can exercise signing, persistence, broadcast, recovery, confirmation, and receipt verification without mainnet funds. Circle Test USDC is the settlement asset for this testnet flow.

The application remains a hybrid system:

- The Next.js backend, PostgreSQL state machine, authentication, ownership checks, quote data, funding simulation, and THB payout simulation are off-chain.
- The Test USDC settlement leg is on-chain on Avalanche Fuji.
- The project does not create a new blockchain and does not deploy a custom smart contract. It calls Circle's existing Test USDC ERC-20 contract.
- USD funding and the final THB payout remain simulated. Only the intermediate Test USDC transfer is real on testnet.

## 2. Architecture

```text
Client / Frontend
        |
        v
Next.js Backend
        |
        v
/advance orchestration
        |
        v
SettlementModule interface
        |
        v
FujiSettlementModule
   |             |
   v             v
PostgreSQL      Fuji RPC
settlement_      |
attempts         v
             Circle Test USDC
                  |
                  v
             Destination wallet
```

Layer responsibilities:

- Client/frontend: authenticates through the current demo session mechanism, calls backend APIs, and renders the returned transfer snapshot. It never signs settlement transactions.
- Next.js backend: owns API handling, same-origin checks, session authentication, owner scoping, transfer orchestration, and public response shaping.
- `/advance` orchestration: takes a bounded processing claim, creates the immutable `SettlementIntent`, calls one bounded settlement step, and maps the result into backend-owned transfer state.
- `SettlementModule`: the stable boundary between backend orchestration and settlement implementation.
- `FujiSettlementModule`: owns the persisted settlement-attempt state machine and recovery decisions.
- PostgreSQL `settlement_attempts`: stores nonce, signed transaction bytes, transaction hash, phase, receipt metadata, and evidence.
- Fuji RPC: provides network identity, balances, fee data, simulation, transaction submission, transaction lookup, receipts, and block height.
- Circle Test USDC: the existing ERC-20 contract called by the signed transaction.

## 3. Network Configuration

- Network: Avalanche Fuji C-Chain
- Chain ID: `43113`
- Circle Test USDC: `0x5425890298aed601595a70AB815c96711a31Bc65`
- Token decimals: `6`
- Default RPC: `https://api.avax-test.network/ext/bc/C/rpc`

The RPC endpoint may be overridden with `AVALANCHE_RPC_URL`. Runtime configuration still rejects a non-Fuji chain ID and a token address other than the pinned Circle Test USDC address.

## 4. Environment Variables

Only variable names and safe placeholders belong in source control:

```dotenv
DATABASE_URL=<postgresql-server-connection-string>
SETTLEMENT_MODULE=fuji
AVALANCHE_CHAIN_ID=43113
AVALANCHE_RPC_URL=https://api.avax-test.network/ext/bc/C/rpc
USDC_TOKEN_ADDRESS=0x5425890298aed601595a70AB815c96711a31Bc65
DESTINATION_SETTLEMENT_ADDRESS=<fuji-destination-wallet-address>
SETTLEMENT_PRIVATE_KEY=<testnet-only-private-key>
SETTLEMENT_CONFIRMATIONS=2
```

- `DATABASE_URL`: server-only PostgreSQL connection used by backend core and the attempt store.
- `SETTLEMENT_MODULE`: selects `fuji`; demo/production modes require an explicit module selection.
- `AVALANCHE_CHAIN_ID`: must be `43113`.
- `AVALANCHE_RPC_URL`: Fuji JSON-RPC endpoint; defaults to the public Avalanche endpoint.
- `USDC_TOKEN_ADDRESS`: must be the pinned Circle Test USDC contract.
- `DESTINATION_SETTLEMENT_ADDRESS`: allowlisted recipient wallet for this deployment.
- `SETTLEMENT_PRIVATE_KEY`: dedicated Fuji testnet signer key. Configure it only through trusted local or deployment secret management. Never commit it or expose it to the browser.
- `SETTLEMENT_CONFIRMATIONS`: confirmation threshold, constrained to `1..64` and defaulting to `2`.

## 5. Important Source Files

Fuji implementation:

- `src/settlement/fuji/config.ts`: validates Fuji-only configuration, the Circle token address, destination, signer key, and confirmation range.
- `src/settlement/fuji/types.ts`: private attempt/gateway/store types and safe error classes. `signedTx` stays inside this private boundary.
- `src/settlement/fuji/store.ts`: PostgreSQL adapter for reading and mutating only `settlement_attempts`.
- `src/settlement/fuji/gateway.ts`: viem-based Fuji RPC, signing, transaction integrity checks, broadcast, reconciliation, receipt/event validation, and read-only preflight.
- `src/settlement/fuji/module.ts`: bounded persisted state machine, FenceGuard integration, recovery, and public `SettlementResult`/`AttemptView` shaping.
- `src/settlement/fuji/index.ts`: public exports for the Fuji implementation.

Integration points:

- `src/settlement/contract.ts`: frozen `SettlementIntent`, `Fence`, `SettlementResult`, `AttemptView`, and `SettlementModule` contract.
- `src/settlement/index.ts`: chooses `fake` or `fuji` and wires the PostgreSQL store, viem gateway, and registered FenceGuard.
- `src/settlement/db-fence-guard.ts`: adapts backend database fencing to the settlement contract.
- `src/domain/settlement-mapping.ts`: validates settlement results and maps them into backend-owned transfer state.
- `src/domain/snapshot.ts`: exposes safe settlement fields and generates the Snowtrace transaction URL.
- `src/server/advance.ts`: owns the bounded claim/orchestration flow and constructs the authoritative intent from the persisted transfer.

## 6. Settlement State Machine

```text
NO ATTEMPT
    |
    v
PREPARED
    |
    v
BROADCAST
    |
    v
PENDING
    |
    +----> CONFIRMED
    |
    +----> FAILED
    |
    +----> REVIEW
```

`step()` is intentionally bounded. It does one meaningful unit of work and returns control to `/advance`; it does not wait in a server request for several confirmations. A transfer can therefore require several authenticated `/advance` calls.

Repeated `/advance` calls do not mean repeated token transfers. Once an attempt exists, the module loads and reconciles that same persisted attempt. Terminal attempts are returned without another broadcast.

## 7. Persist-Before-Broadcast

The core safety invariant is:

1. Read the pending signer nonce.
2. Create and sign the ERC-20 transfer transaction.
3. Compute the transaction hash locally from the signed bytes.
4. Persist the nonce.
5. Persist the signed bytes.
6. Persist the transaction hash.
7. Commit the database transaction.
8. Only on a later bounded step, broadcast those persisted signed bytes.

The initial step returns `NOT_SUBMITTED` while the attempt is `PREPARED`. A later step loads that row, validates the signed transaction against all immutable attempt metadata, and broadcasts it.

This ordering removes the dangerous crash window where a transaction could be broadcast without a durable recovery record. If a process fails after persistence or around submission, the next worker has the exact signed transaction and hash needed for safe reconciliation or idempotent rebroadcast.

## 8. FenceGuard / Concurrency Safety

Backend core increments `transfers.claim_epoch` when `/advance` takes a claim. The resulting `{ transferId, epoch }` fence proves that a worker still owns the current claim.

- Stale epochs are rejected.
- The database FenceGuard reads the transfer's `claim_epoch` with `SELECT ... FOR UPDATE`.
- Every `settlement_attempts` insert or update performs the fence check inside the same short database transaction as the protected mutation.
- RPC preparation, broadcast, transaction lookup, receipt lookup, and confirmation checks occur outside database transactions.
- The unresolved-signer lookup prevents a signer from preparing a second in-flight attempt.
- `UNIQUE (chain_id, signer, nonce)` protects nonce identity.
- `UNIQUE (chain_id, tx_hash)` protects transaction identity.
- The partial unresolved-signer index permits at most one `PREPARED`, `BROADCAST`, or `PENDING` attempt per signer and chain.

Part 4 never updates `transfers`. Backend core owns claims and maps `SettlementResult` into transfer state after the settlement step returns.

## 9. Recovery and Reconciliation

- Lost RPC response: the durable attempt remains available. A later step uses the same signed bytes and same hash; it never creates a replacement transaction.
- Crash after persistence but before broadcast: the row remains `PREPARED`; a later step validates and broadcasts the stored bytes.
- Crash after broadcast but before the phase update: the same serialized transaction may be submitted again, preserving nonce/hash identity, and then reconciled. No new nonce or transfer is created.
- Pending receipt: the attempt advances to or remains `PENDING`; a later `/advance` call inspects the same hash.
- Repeated `/advance`: terminal attempts return their persisted outcome, while non-terminal attempts continue from their current phase.

**The same signed transaction and transaction hash are reused.** Never create a new transfer or a second attempt merely because submission or confirmation is uncertain.

## 10. Receipt Verification

Before returning `CONFIRMED`, the gateway verifies:

- The RPC reports Avalanche Fuji chain ID `43113`.
- The fetched transaction hash equals the persisted hash.
- Transaction chain ID, sender, nonce, and target token contract match the attempt.
- Decoded calldata is `transfer(destination, units)` with the exact persisted values.
- The receipt belongs to the same transaction and has a block hash.
- Receipt status is successful; a reverted receipt becomes `FAILED`.
- Exactly one matching ERC-20 `Transfer` event exists on the configured Test USDC contract.
- Event sender, destination, and base units exactly match the attempt.
- The configured number of confirmations has been reached.

Malformed, contradictory, or ambiguous transaction/receipt evidence goes to `REVIEW`. The implementation does not guess or silently accept partial evidence.

## 11. Amount Ownership

Part 4 must not calculate exchange rates, fees, or settlement amounts. Its sole authoritative amount is:

```text
SettlementIntent.units
```

Backend core constructs this immutable value from the accepted quote/transfer data before calling the settlement module. The gateway converts the decimal string to `bigint` only for ERC-20 calldata; it does not recompute business amounts.

The controlled live run demonstrated `9800000` base units, equal to `9.8` Test USDC at six decimals.

## 12. Database Ownership

Part 4 reads and writes `settlement_attempts` only. It stores attempt identity, immutable transfer parameters, nonce, private signed bytes, transaction hash, phase, receipt metadata, evidence, and the creation fence.

Part 4 does not mutate `transfers`. Backend core remains responsible for mapping a safe `SettlementResult` into transfer status, public settlement fields, and transfer events.

The backend team's schema source of truth remains `db/migrations/0001_init.sql`. Do not apply migrations automatically during application startup or deployment verification.

## 13. Public API / Frontend Integration

The frontend does not need a wallet. The backend signs server-side with the configured test-only signer.

The owner-scoped transfer snapshot exposes:

- `settlement.mode`
- `settlement.status`
- `settlement.chainId`
- `settlement.tokenSymbol`
- `settlement.tokenAddress`
- `settlement.tokenDecimals`
- `settlement.txHash`
- `settlement.explorerUrl`
- `settlement.verifiedAt`

Expected presentation:

```text
Sent on Avalanche Fuji
TESTNET · FUJI

0xc021...0bdc
View on Snowtrace ↗
```

Use the backend-provided `explorerUrl`; do not rebuild or independently infer blockchain state in the frontend. This repository is API-only, so the actual transfer card/link rendering remains frontend integration work.

## 14. Authentication / Demo Flow

The current demo uses a `demo_session` cookie:

- `scripts/demo-seed.mjs` creates a random token, stores only its SHA-256 hash with an owner, and creates a synthetic recipient/open quote.
- `requireSession()` reads the cookie, hashes it, and loads an unexpired session.
- Transfer routes use the authenticated owner ID for owner-scoped reads and mutations.
- `scripts/demo-flow.sh` demonstrates create, simulated funding, bounded `/advance`, payout, and final snapshot calls using the cookie returned by the seed script.

The bootstrap is temporary because this API-only repository has no normal end-user login/session UI yet. Never place cookie values in source control, logs, issue descriptions, or PR text.

## 15. Preflight

`preflight()` is read-only. Configuration parsing and gateway checks cover:

- Fuji RPC connectivity.
- RPC chain ID `43113`.
- Contract bytecode at the configured token address.
- Token symbol `USDC` and `6` decimals.
- A valid configured signer derived server-side from the test-only key.
- A valid destination distinct from the signer.
- Non-zero Test AVAX readiness for gas.
- Non-zero Circle Test USDC readiness.

Preflight does not sign or broadcast a transaction and does not mutate blockchain or database state.

## 16. Tests

Relevant test files include:

- `tests/contract/settlement.contract.ts`
- `tests/contract/fuji.contract.test.ts`
- `tests/db/fuji-settlement.test.ts`
- `tests/settlement/fuji-config.test.ts`
- `tests/settlement/fuji-gateway.test.ts`
- `tests/settlement/index.test.ts`
- `tests/settlement/intent.test.ts`
- `tests/domain/settlement-mapping.test.ts`
- `tests/domain/snapshot.test.ts`
- `tests/api/advance.test.ts`

Final focused verification:

- Node: `v22.22.0`
- Fuji/config/gateway/contract tests: `22/22 PASS`
- `pnpm typecheck`: `PASS`
- `pnpm lint`: `PASS`
- `git diff --check`: `PASS`
- Full non-live suite: `350 PASS`, `67 SKIPPED` across 27 files. The skipped tests are database suites guarded against non-local database targets; no real Supabase database or blockchain transaction was touched by this test run.

All automated Fuji tests use mocks or isolated test databases. They must not contain a live signer or broadcast a live transaction.

## 17. Live Fuji Proof

- Network: Avalanche Fuji
- Transaction: `0xc021d58f73fb6890c75a3b923d2777011bd7c1f77c81832154088327598c0bdc`
- Snowtrace: https://testnet.snowtrace.io/tx/0xc021d58f73fb6890c75a3b923d2777011bd7c1f77c81832154088327598c0bdc
- Block: `59523076`
- Amount: `9.8 Test USDC` (`9800000` base units)
- From: `0xF7c909887933D6717972ab70Ef83f9F4198447a6`
- To: `0x740f00EF9410E7631B2c22CAa750F5EA62273D20`
- Circle Test USDC: `0x5425890298aed601595a70AB815c96711a31Bc65`
- Settlement attempt: `stl_e1558e19-f5af-43a9-bf89-756b3c62364e`
- Transfer: `tr_dd7d1a85-92ef-4636-994f-f809f431fb12`
- Database attempt phase: `CONFIRMED`
- Recorded confirmations: `7`
- Relevant attempts: exactly `1`
- Duplicate nonce/hash: none

Balance proof:

- Wallet A: `40.0 -> 30.2 Test USDC`
- Wallet B: `0.0 -> 9.8 Test USDC`

This public proof is sufficient. Do not rerun a live settlement as part of review, CI, deployment, or merge.

## 18. Security

- Fuji testnet only; no mainnet configuration is supported by this implementation.
- The private key is server-only and must never reach frontend code.
- The private key is not stored in PostgreSQL.
- Signed transaction bytes are private persistence data and are omitted from `SettlementResult`, `AttemptView`, snapshots, and public APIs.
- Do not print `DATABASE_URL`, private keys, cookie/session tokens, or signed transaction bytes.
- `.env.local` is ignored and must never be staged.
- The receiving wallet does not need AVAX gas merely to receive Test USDC.
- Public addresses, chain ID, transaction hash, block number, and explorer URL may be documented.

## 19. Known Limitations

- Testnet only.
- Source funding is simulated.
- THB payout is simulated.
- There is no project-specific smart contract.
- Settlement calls Circle's existing Test USDC contract.
- Most business orchestration remains off-chain; only the settlement leg is on-chain.
- Demo authentication is temporary and bootstrap-oriented.
- This backend repository does not implement the frontend transfer card; the frontend must render the provided snapshot fields.

## 20. Frontend Checklist

- Call the owner-authenticated `GET /api/transfers/{id}` snapshot endpoint.
- Read `settlement.status`.
- Show a `TESTNET · FUJI` badge for the current architecture.
- Show a shortened `settlement.txHash` while preserving the full value for copy/accessibility.
- Link “View on Snowtrace” using `settlement.explorerUrl`.
- Show `settlement.verifiedAt` after confirmation.
- Never request, receive, or store the settlement private key.
- Do not require a user wallet connection for the current server-signed architecture.

## 21. Deployment Checklist

- Use Node.js 22 (`>=22 <23`).
- Configure `DATABASE_URL` through server secret management.
- Set `SETTLEMENT_MODULE=fuji` explicitly.
- Configure/check the Fuji RPC endpoint.
- Confirm chain ID `43113`.
- Confirm Circle Test USDC address.
- Configure the allowlisted destination address.
- Configure the dedicated Fuji test signer key as a server-only secret.
- Configure the desired confirmation count (`1..64`).
- Confirm the existing backend migrations/schema are compatible; do not replace backend-owned migrations.
- Run the read-only preflight.
- Run non-live tests.
- Do not perform a live settlement automatically at deploy time.

## 22. Merge Notes

Part 4 primarily owns:

- `src/settlement/fuji/**`
- Fuji contract/config/gateway/database tests
- Fuji integration documentation
- The minimal module factory and dependency wiring needed to select `fuji`

Likely conflict areas are:

- `package.json`
- `pnpm-lock.yaml`
- `src/config/env.ts`
- `src/settlement/index.ts`
- `README.md`

Resolve these files semantically. Preserve backend-core behavior, all newer Part 2/Part 3 changes, frontend files, unrelated scripts, and dependency updates. Do not replace another repository's tree with this repository's tree.

## 23. Final Status

- Blockchain settlement integration: **COMPLETE**
- Database readiness: **PASS**
- Fuji readiness: **PASS**
- Live testnet settlement: **CONFIRMED**
- Frontend integration: backend API fields are ready; frontend rendering remains integration work.
