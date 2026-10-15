/**
 * Row types returned by the repositories in `src/db/repos/` (camelCase).
 *
 * Amount columns (numeric(38,0)) and int8 columns are returned as base-10
 * integer strings; convert with `src/lib/money.ts` in domain code.
 * jsonb columns are returned as parsed JSON.
 * The string unions mirror the CHECK constraints in db/migrations/0001_init.sql.
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

export type FundingSubstatus = "PENDING" | "ACCEPTED" | "DECLINED";
export type SettlementSubstatus =
  | "NOT_STARTED"
  | "PREPARING"
  | "BROADCAST"
  | "PENDING"
  | "CONFIRMED"
  | "FAILED"
  | "REVIEW_REQUIRED";
export type PayoutSubstatus = "NOT_STARTED" | "PENDING" | "PAID" | "FAILED" | "UNKNOWN";
export type NotificationChannel = "NTFY";
export type NotificationStatus = "NOT_STARTED" | "PENDING" | "SENT" | "FAILED" | "DISABLED";
export type QuoteStatus = "OPEN" | "ACCEPTED" | "EXPIRED";
export type DemoScenario = "HAPPY_PATH" | "FUNDING_DECLINED" | "PAYOUT_FAILED";
export type Purpose = "PERSONAL_REMITTANCE";
export type IdempotencyScope = "CREATE_TRANSFER" | "FUNDING" | "PAYOUT_RETRY";
export type FundingAttemptStatus = "ACCEPTED" | "DECLINED";
export type PayoutAttemptStatus = "PENDING" | "PAID" | "FAILED" | "UNKNOWN";
export type SettlementAttemptPhase =
  | "PREPARED"
  | "BROADCAST"
  | "PENDING"
  | "CONFIRMED"
  | "FAILED"
  | "REVIEW";

/** Unsigned base-10 integer string (numeric(38,0) / int8 column). */
export type AmountString = string;

/** JSON value stored in a jsonb column. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface RecipientSnapshot {
  id: string;
  name: string;
  bankLabel: string;
  accountDisplay: string;
  isSynthetic: boolean;
  [key: string]: Json;
}

export interface Issue {
  code: string;
  message: string;
  retryable: boolean;
}

/** Amount/FX fields shared by quotes and transfers. */
export interface AmountFields {
  sourceCurrency: string;
  destinationCurrency: string;
  sourceDebitMinor: AmountString;
  feeMinor: AmountString;
  conversionPrincipalMinor: AmountString;
  destinationNetMinor: AmountString;
  settlementTokenUnits: AmountString;
  fxRateNumerator: AmountString;
  fxRateDenominator: AmountString;
  fixtureVersion: string;
}

export interface QuoteRow extends AmountFields {
  id: string;
  ownerId: string;
  recipientId: string;
  recipientSnapshot: RecipientSnapshot;
  sourceCountry: string;
  destinationCountry: string;
  chainId: number;
  status: QuoteStatus;
  createdAt: Date;
  expiresAt: Date;
  acceptedAt: Date | null;
}

export interface TransferRow extends AmountFields {
  id: string;
  ownerId: string;
  quoteId: string;
  status: TransferStatus;
  version: number;
  purpose: Purpose;
  demoScenario: DemoScenario;
  recipientSnapshot: RecipientSnapshot;
  fundingStatus: FundingSubstatus;
  fundingReference: string | null;
  settlementStatus: SettlementSubstatus;
  settlementTxHash: string | null;
  settlementEvidence: Json | null;
  settlementVerifiedAt: Date | null;
  payoutStatus: PayoutSubstatus;
  payoutReference: string | null;
  notificationChannel: NotificationChannel;
  notificationStatus: NotificationStatus;
  notificationSentAt: Date | null;
  lastIssue: Issue | null;
  receipt: Json | null;
  claimEpoch: number;
  claimExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TransferEventRow {
  /** int8 identity, as a string. */
  id: string;
  transferId: string;
  sequence: number;
  fromStatus: TransferStatus | null;
  toStatus: TransferStatus;
  reason: string | null;
  attemptRef: string | null;
  createdAt: Date;
}

export interface IdempotencyKeyRow {
  ownerId: string;
  scope: IdempotencyScope;
  key: string;
  fingerprint: string;
  transferId: string | null;
  responseStatus: number | null;
  createdAt: Date;
}

export interface FundingAttemptRow {
  id: string;
  transferId: string;
  requestId: string;
  status: FundingAttemptStatus;
  reference: string;
  createdAt: Date;
}

export interface PayoutAttemptRow {
  id: string;
  transferId: string;
  requestId: string;
  attemptNo: number;
  status: PayoutAttemptStatus;
  reference: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SettlementAttemptRow {
  id: string;
  transferId: string;
  chainId: number;
  tokenAddress: string;
  signer: string;
  destination: string;
  units: AmountString;
  /** int8, as a string. */
  nonce: string;
  /** Raw signed bytes. Never expose outside part 4's module or in any API response. */
  signedTx: string | null;
  txHash: string | null;
  phase: SettlementAttemptPhase;
  /** int8, as a string. */
  receiptBlockNumber: string | null;
  receiptBlockHash: string | null;
  evidence: Json | null;
  createdFence: number;
  createdAt: Date;
  updatedAt: Date;
}
