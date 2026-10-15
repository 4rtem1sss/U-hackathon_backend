/**
 * Shared vocabulary for the transfer domain (api-contract sections 5, 6 and 8).
 * Every value here is part of the public API or the database check constraints:
 * do not rename without updating both.
 */

export const TRANSFER_STATUSES = [
  "FUNDING_PENDING",
  "FUNDED_SIMULATED",
  "FUNDING_FAILED",
  "SETTLEMENT_PENDING",
  "SETTLED",
  "SETTLEMENT_FAILED",
  "PAYOUT_PENDING",
  "PAYOUT_FAILED",
  "REVIEW_REQUIRED",
  "COMPLETED_SIMULATED",
] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

export const NEXT_ACTIONS = ["SIMULATE_FUNDING", "ADVANCE", "RETRY_PAYOUT", "NONE"] as const;
export type NextAction = (typeof NEXT_ACTIONS)[number];

export const FUNDING_SUBSTATUSES = ["PENDING", "ACCEPTED", "DECLINED"] as const;
export type FundingSubstatus = (typeof FUNDING_SUBSTATUSES)[number];

export const SETTLEMENT_SUBSTATUSES = [
  "NOT_STARTED",
  "PREPARING",
  "BROADCAST",
  "PENDING",
  "CONFIRMED",
  "FAILED",
  "REVIEW_REQUIRED",
] as const;
export type SettlementSubstatus = (typeof SETTLEMENT_SUBSTATUSES)[number];

export const PAYOUT_SUBSTATUSES = ["NOT_STARTED", "PENDING", "PAID", "FAILED", "UNKNOWN"] as const;
export type PayoutSubstatus = (typeof PAYOUT_SUBSTATUSES)[number];

export const QUOTE_STATUSES = ["OPEN", "ACCEPTED", "EXPIRED"] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

export const DEMO_SCENARIOS = ["HAPPY_PATH", "FUNDING_DECLINED", "PAYOUT_FAILED"] as const;
export type DemoScenario = (typeof DEMO_SCENARIOS)[number];

export const PURPOSES = ["PERSONAL_REMITTANCE"] as const;
export type Purpose = (typeof PURPOSES)[number];

/** Idempotency key scopes. CREATE_TRANSFER rows have a null transfer_id. */
export const IDEMPOTENCY_SCOPES = ["CREATE_TRANSFER", "FUNDING", "PAYOUT_RETRY"] as const;
export type IdempotencyScope = (typeof IDEMPOTENCY_SCOPES)[number];

/** Narrowing helper, e.g. `isOneOf(TRANSFER_STATUSES, row.status)`. */
export function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}
