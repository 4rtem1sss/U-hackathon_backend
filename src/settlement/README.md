# src/settlement

Part 3 <-> part 4 boundary (task T6): `contract.ts` (SettlementIntent, Fence,
SettlementResult, SettlementModule), the scriptable `FakeSettlementModule`, and
part 4's real module. Part 3 decides *when* to settle; part 4 decides *how* on
chain and writes only `settlement_attempts`.

`fuji/` implements the production path with viem. It signs locally, commits
`nonce` + `signed_tx` + `tx_hash` before broadcast, and always reconciles the
same persisted transaction. `getAttempt()` is DB-only and omits signed bytes.
Every attempt mutation invokes the injected `FenceGuard` in the same short DB
transaction; RPC calls run outside DB transactions.
