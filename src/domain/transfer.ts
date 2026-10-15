import type {
  DemoScenario,
  FundingSubstatus,
  PayoutSubstatus,
  Purpose,
  SettlementSubstatus,
  TransferStatus,
} from "./enums";
import type { Receipt } from "./receipt";
import type { Evidence, Issue } from "./settlement-types";

/** Immutable recipient snapshot copied from the accepted quote. */
export interface RecipientSnapshot {
  id: string;
  name: string;
  bankLabel: string;
  accountDisplay: string;
  isSynthetic: boolean;
}

/** Immutable amounts copied from the accepted quote (minor/base units). */
export interface TransferAmounts {
  sourceCurrency: "USD";
  destinationCurrency: "THB";
  sourceDebitMinor: bigint;
  feeMinor: bigint;
  conversionPrincipalMinor: bigint;
  destinationNetMinor: bigint;
  settlementTokenUnits: bigint;
}

export interface TransferFx {
  fixtureVersion: string;
  rateNumerator: bigint;
  rateDenominator: bigint;
}

export interface FundingState {
  status: FundingSubstatus;
  reference: string | null;
}

export interface SettlementState {
  status: SettlementSubstatus;
  txHash: string | null;
  /** Verified chain evidence; only set when status is CONFIRMED. Never exposed raw. */
  evidence: Evidence | null;
  verifiedAt: Date | null;
}

export interface PayoutState {
  status: PayoutSubstatus;
  reference: string | null;
}

/** Domain view of a `transfers` row (camelCase, bigint amounts, Date timestamps). */
export interface TransferRecord {
  id: string;
  ownerId: string;
  quoteId: string;
  status: TransferStatus;
  version: number;
  purpose: Purpose;
  demoScenario: DemoScenario;
  recipient: RecipientSnapshot;
  amounts: TransferAmounts;
  fx: TransferFx;
  funding: FundingState;
  settlement: SettlementState;
  payout: PayoutState;
  lastIssue: Issue | null;
  receipt: Receipt | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Domain view of a `transfer_events` row. `fromStatus` is null only for the creation event. */
export interface TransferEvent {
  sequence: number;
  fromStatus: TransferStatus | null;
  toStatus: TransferStatus;
  reason: string;
  createdAt: Date;
}

/** An event planned by the domain; the repository assigns `sequence` (max + 1) on insert. */
export type NewTransferEvent = Omit<TransferEvent, "sequence">;

export interface NewTransferInput {
  id: string;
  ownerId: string;
  quoteId: string;
  purpose: Purpose;
  demoScenario: DemoScenario;
  recipient: RecipientSnapshot;
  amounts: TransferAmounts;
  fx: TransferFx;
}

/**
 * Build the initial FUNDING_PENDING record (version 1) and its creation event (sequence 1),
 * matching the "Newly created FUNDING_PENDING" snapshot variant.
 */
export function newTransferRecord(
  input: NewTransferInput,
  now: Date,
  reason = "TRANSFER_CREATED",
): { record: TransferRecord; event: TransferEvent } {
  const at = new Date(now.getTime());
  const record: TransferRecord = {
    id: input.id,
    ownerId: input.ownerId,
    quoteId: input.quoteId,
    status: "FUNDING_PENDING",
    version: 1,
    purpose: input.purpose,
    demoScenario: input.demoScenario,
    recipient: { ...input.recipient },
    amounts: { ...input.amounts },
    fx: { ...input.fx },
    funding: { status: "PENDING", reference: null },
    settlement: { status: "NOT_STARTED", txHash: null, evidence: null, verifiedAt: null },
    payout: { status: "NOT_STARTED", reference: null },
    lastIssue: null,
    receipt: null,
    createdAt: at,
    updatedAt: at,
  };
  return {
    record,
    event: { sequence: 1, fromStatus: null, toStatus: "FUNDING_PENDING", reason, createdAt: at },
  };
}
