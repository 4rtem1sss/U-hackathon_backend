# src/domain

Pure transfer domain logic (task T3). No DB access; persistence goes through `src/db/`.

- `enums.ts`: shared vocabulary (statuses, substatuses, next actions, scenarios, scopes).
- `transfer.ts`: `TransferRecord` / `TransferEvent` domain types, `newTransferRecord()`.
- `transitions.ts`: allowed-transition table, `nextActionFor()`, `planTransition()`
  (version + 1, event), `planPatch()` (same-status change), `assertInvariants()`
  (api-contract section 6 snapshot variants), errors and their ApiError mapping.
- `settlement-mapping.ts`: `mapSettlementResult()` / `mapSettlementError()` (plan section 4.3).
- `settlement-types.ts`: local copy of plan 4.2 result types until `src/settlement/contract.ts` lands.
- `snapshot.ts`: `toSnapshot()` building the exact api-contract section 6 shape.
- `receipt.ts`: demo receipt builder.

Callers persist `next` with `WHERE id = $1 AND version = <old version>` and append the
event with `sequence = max + 1` in the same transaction.
