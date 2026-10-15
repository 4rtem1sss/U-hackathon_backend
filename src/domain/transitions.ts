import { ApiError } from "@/lib/errors";
import type { NextAction, TransferStatus } from "./enums";
import type { Issue } from "./settlement-types";
import type {
  FundingState,
  NewTransferEvent,
  NotificationState,
  PayoutState,
  SettlementState,
  TransferRecord,
} from "./transfer";
import type { Receipt } from "./receipt";

/**
 * Allowed status transitions (api-contract section 8: normal path + failure paths).
 * Anything not listed is forbidden, including self-transitions; same-status changes
 * (substatus, txHash, lastIssue) go through `planPatch` instead.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<TransferStatus, readonly TransferStatus[]>> = {
  FUNDING_PENDING: ["FUNDED_SIMULATED", "FUNDING_FAILED"],
  FUNDED_SIMULATED: ["SETTLEMENT_PENDING"],
  FUNDING_FAILED: [],
  SETTLEMENT_PENDING: ["SETTLED", "SETTLEMENT_FAILED", "REVIEW_REQUIRED"],
  SETTLED: ["PAYOUT_PENDING"],
  SETTLEMENT_FAILED: [],
  PAYOUT_PENDING: ["COMPLETED_SIMULATED", "PAYOUT_FAILED", "REVIEW_REQUIRED"],
  PAYOUT_FAILED: ["PAYOUT_PENDING"],
  REVIEW_REQUIRED: [],
  COMPLETED_SIMULATED: [],
};

export function canTransition(from: TransferStatus, to: TransferStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

const NEXT_ACTION: Readonly<Record<TransferStatus, NextAction>> = {
  FUNDING_PENDING: "SIMULATE_FUNDING",
  FUNDED_SIMULATED: "ADVANCE",
  FUNDING_FAILED: "NONE",
  SETTLEMENT_PENDING: "ADVANCE",
  SETTLED: "ADVANCE",
  SETTLEMENT_FAILED: "NONE",
  PAYOUT_PENDING: "ADVANCE",
  PAYOUT_FAILED: "RETRY_PAYOUT",
  REVIEW_REQUIRED: "NONE",
  COMPLETED_SIMULATED: "NONE",
};

/** api-contract section 8 `nextAction` table. */
export function nextActionFor(status: TransferStatus): NextAction {
  return NEXT_ACTION[status];
}

/** Statuses with no outgoing transition (held or finished). */
export function isTerminalStatus(status: TransferStatus): boolean {
  return ALLOWED_TRANSITIONS[status].length === 0;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A requested status change is not in the transition table. Maps to 409 INVALID_STATE. */
export class InvalidTransitionError extends Error {
  readonly from: TransferStatus;
  readonly to: TransferStatus;

  constructor(from: TransferStatus, to: TransferStatus, message?: string) {
    super(message ?? `transition ${from} -> ${to} is not allowed`);
    this.name = "InvalidTransitionError";
    this.from = from;
    this.to = to;
  }
}

/**
 * A record would violate the section 6 snapshot variants. This is a server bug
 * (bad patch), not a client conflict, so it maps to 500 INTERNAL_ERROR.
 */
export class TransferInvariantError extends Error {
  readonly violations: readonly string[];

  constructor(status: TransferStatus, violations: readonly string[]) {
    super(`transfer invariants violated for ${status}: ${violations.join("; ")}`);
    this.name = "TransferInvariantError";
    this.violations = violations;
  }
}

export function invalidTransitionToApiError(err: InvalidTransitionError): ApiError {
  return new ApiError("INVALID_STATE", { cause: err });
}

/** Map a domain error to an ApiError; returns null for anything else. */
export function domainErrorToApiError(err: unknown): ApiError | null {
  if (err instanceof InvalidTransitionError) return invalidTransitionToApiError(err);
  if (err instanceof TransferInvariantError) return new ApiError("INTERNAL_ERROR", { cause: err });
  return null;
}

// ---------------------------------------------------------------------------
// Invariants (api-contract section 6 "required snapshot variants")
// ---------------------------------------------------------------------------

function settlementUntouched(s: SettlementState, v: string[]): void {
  if (s.status !== "NOT_STARTED") v.push(`settlement.status must be NOT_STARTED (got ${s.status})`);
  if (s.txHash !== null) v.push("settlement.txHash must be null");
}

function payoutUntouched(p: PayoutState, v: string[]): void {
  if (p.status !== "NOT_STARTED") v.push(`payout.status must be NOT_STARTED (got ${p.status})`);
  if (p.reference !== null) v.push("payout.reference must be null");
}

function fundingAccepted(f: FundingState, v: string[]): void {
  if (f.status !== "ACCEPTED") v.push(`funding.status must be ACCEPTED (got ${f.status})`);
}

function settlementConfirmed(s: SettlementState, v: string[]): void {
  if (s.status !== "CONFIRMED") v.push(`settlement.status must be CONFIRMED (got ${s.status})`);
}

/** Returns human-readable violations; empty when the record is consistent. */
export function checkInvariants(r: TransferRecord): string[] {
  const v: string[] = [];
  const { funding: f, settlement: s, payout: p } = r;

  // Global rules.
  if (!Number.isInteger(r.version) || r.version < 1) v.push("version must be a positive integer");
  if (r.updatedAt.getTime() < r.createdAt.getTime()) v.push("updatedAt must not be before createdAt");
  for (const [k, amount] of Object.entries(r.amounts)) {
    if (typeof amount === "bigint" && amount < 0n) v.push(`amounts.${k} must not be negative`);
  }
  if ((f.status === "PENDING") !== (f.reference === null)) {
    v.push("funding.reference must be null exactly when funding.status is PENDING");
  }
  const confirmed = s.status === "CONFIRMED";
  if (confirmed !== (s.evidence !== null)) v.push("settlement.evidence must be set exactly when CONFIRMED");
  if (confirmed !== (s.verifiedAt !== null)) v.push("settlement.verifiedAt must be set exactly when CONFIRMED");
  if (confirmed && s.txHash === null) v.push("settlement.txHash is required when CONFIRMED");
  if ((s.status === "BROADCAST" || s.status === "PENDING" || s.status === "FAILED") && s.txHash === null) {
    v.push(`settlement.txHash is required when settlement is ${s.status}`);
  }
  if ((r.status === "COMPLETED_SIMULATED") !== (r.receipt !== null)) {
    v.push("receipt must be set exactly when COMPLETED_SIMULATED");
  }
  if (p.status !== "NOT_STARTED" && !confirmed) v.push("payout cannot start before settlement is CONFIRMED");
  const n = r.notification;
  if (n.status !== "NOT_STARTED" && r.status !== "COMPLETED_SIMULATED") {
    v.push("notification can only start once the transfer is COMPLETED_SIMULATED");
  }
  if ((n.status === "SENT") !== (n.sentAt !== null)) v.push("notification.sentAt must be set exactly when SENT");

  // Per-status variants.
  switch (r.status) {
    case "FUNDING_PENDING":
      if (f.status !== "PENDING") v.push(`funding.status must be PENDING (got ${f.status})`);
      settlementUntouched(s, v);
      payoutUntouched(p, v);
      break;
    case "FUNDED_SIMULATED":
      fundingAccepted(f, v);
      settlementUntouched(s, v);
      payoutUntouched(p, v);
      break;
    case "FUNDING_FAILED":
      if (f.status !== "DECLINED") v.push(`funding.status must be DECLINED (got ${f.status})`);
      settlementUntouched(s, v);
      payoutUntouched(p, v);
      break;
    case "SETTLEMENT_PENDING":
      fundingAccepted(f, v);
      if (s.status !== "PREPARING" && s.status !== "BROADCAST" && s.status !== "PENDING") {
        v.push(`settlement.status must be PREPARING, BROADCAST or PENDING (got ${s.status})`);
      }
      if (s.status === "PREPARING" && s.txHash !== null) v.push("settlement.txHash must be null while PREPARING");
      payoutUntouched(p, v);
      break;
    case "SETTLED":
      fundingAccepted(f, v);
      settlementConfirmed(s, v);
      payoutUntouched(p, v);
      break;
    case "SETTLEMENT_FAILED":
      fundingAccepted(f, v);
      if (s.status !== "FAILED") v.push(`settlement.status must be FAILED (got ${s.status})`);
      payoutUntouched(p, v);
      break;
    case "PAYOUT_PENDING":
      fundingAccepted(f, v);
      settlementConfirmed(s, v);
      if (p.status !== "PENDING" && p.status !== "UNKNOWN") {
        v.push(`payout.status must be PENDING or UNKNOWN (got ${p.status})`);
      }
      break;
    case "PAYOUT_FAILED":
      fundingAccepted(f, v);
      settlementConfirmed(s, v);
      if (p.status !== "FAILED") v.push(`payout.status must be FAILED (got ${p.status})`);
      if (p.reference === null) v.push("payout.reference is required");
      break;
    case "COMPLETED_SIMULATED":
      fundingAccepted(f, v);
      settlementConfirmed(s, v);
      if (p.status !== "PAID") v.push(`payout.status must be PAID (got ${p.status})`);
      if (p.reference === null) v.push("payout.reference is required");
      break;
    case "REVIEW_REQUIRED":
      fundingAccepted(f, v);
      if (s.status === "REVIEW_REQUIRED") {
        // Settlement review: payout never started.
        payoutUntouched(p, v);
      } else if (s.status === "CONFIRMED") {
        // Payout review: verified settlement evidence must be retained.
        if (p.status === "NOT_STARTED" || p.status === "PAID") {
          v.push(`payout.status must be PENDING, FAILED or UNKNOWN in a payout review (got ${p.status})`);
        }
      } else {
        v.push(`settlement.status must be REVIEW_REQUIRED or CONFIRMED (got ${s.status})`);
      }
      break;
  }
  return v;
}

export function assertInvariants(record: TransferRecord): void {
  const violations = checkInvariants(record);
  if (violations.length > 0) throw new TransferInvariantError(record.status, violations);
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/** Mutable parts of a transfer. Amounts, recipient, fx, ids and scenario are immutable. */
export interface TransferPatch {
  funding?: Partial<FundingState>;
  settlement?: Partial<SettlementState>;
  payout?: Partial<PayoutState>;
  notification?: Partial<NotificationState>;
  lastIssue?: Issue | null;
  receipt?: Receipt | null;
}

function applyPatch(record: TransferRecord, patch: TransferPatch, now: Date): TransferRecord {
  return {
    ...record,
    funding: { ...record.funding, ...patch.funding },
    settlement: { ...record.settlement, ...patch.settlement },
    payout: { ...record.payout, ...patch.payout },
    notification: { ...record.notification, ...patch.notification },
    lastIssue: patch.lastIssue !== undefined ? patch.lastIssue : record.lastIssue,
    receipt: patch.receipt !== undefined ? patch.receipt : record.receipt,
    version: record.version + 1,
    updatedAt: new Date(now.getTime()),
  };
}

export interface PlannedTransition {
  /** The record to persist with `WHERE version = <record.version>` (optimistic check). */
  next: TransferRecord;
  /** Event to append; the repository assigns `sequence`. */
  event: NewTransferEvent;
}

/**
 * Plan a status transition. Pure: returns the next record (version + 1, updatedAt = now)
 * and the event to append. Throws `InvalidTransitionError` for a forbidden pair and
 * `TransferInvariantError` if the patched record breaks a section 6 variant.
 */
export function planTransition(
  record: TransferRecord,
  to: TransferStatus,
  patch: TransferPatch,
  reason: string,
  now: Date,
): PlannedTransition {
  if (!canTransition(record.status, to)) throw new InvalidTransitionError(record.status, to);
  const next = { ...applyPatch(record, patch, now), status: to };
  assertInvariants(next);
  return {
    next,
    event: { fromStatus: record.status, toStatus: to, reason, createdAt: new Date(now.getTime()) },
  };
}

/**
 * Plan a same-status change of the public snapshot (substatus, txHash, lastIssue …).
 * Bumps version (the snapshot changed) but appends no event.
 */
export function planPatch(record: TransferRecord, patch: TransferPatch, now: Date): TransferRecord {
  const next = applyPatch(record, patch, now);
  assertInvariants(next);
  return next;
}
