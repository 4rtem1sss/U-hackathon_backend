# src/domain

Transfer domain logic (task T3+): status/substatus enums, transition table,
`nextAction`, `applyTransition` (version check + event), snapshot builder
matching api-contract section 6, funding and payout simulators.
Pure functions where possible; persistence goes through `src/db/`.
