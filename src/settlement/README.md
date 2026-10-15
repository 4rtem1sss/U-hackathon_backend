# src/settlement

Part 3 <-> part 4 boundary (task T6): `contract.ts` (SettlementIntent, Fence,
SettlementResult, SettlementModule), the scriptable `FakeSettlementModule`, and
part 4's real module. Part 3 decides *when* to settle; part 4 decides *how* on
chain and writes only `settlement_attempts`.
