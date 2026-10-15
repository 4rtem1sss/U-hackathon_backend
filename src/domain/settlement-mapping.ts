import { formatAmount } from "@/lib/money";
import type { Evidence, Issue, SettlementResult } from "./settlement-types";
import type { TransferRecord } from "./transfer";
import { InvalidTransitionError, planPatch, planTransition, type PlannedTransition, type TransferPatch } from "./transitions";

/** Fuji C-Chain; the only chain this demo settles on. */
export const SETTLEMENT_CHAIN_ID = 43113;

export const ISSUE_DEPENDENCY_UNAVAILABLE: Issue = {
  code: "DEPENDENCY_UNAVAILABLE",
  message: "Settlement service is temporarily unavailable.",
  retryable: true,
};

export const ISSUE_SETTLEMENT_REVERTED: Issue = {
  code: "SETTLEMENT_REVERTED",
  message: "The testnet settlement transaction reverted.",
  retryable: false,
};

export const ISSUE_SETTLEMENT_REVIEW: Issue = {
  code: "SETTLEMENT_REVIEW_REQUIRED",
  message: "The settlement outcome could not be confirmed safely and is held for review.",
  retryable: false,
};

export type SettlementMapping =
  | (PlannedTransition & {
      kind: "TRANSITION";
      /** True when the caller must create payout attempt #1 (stable request ID) in the same DB tx. */
      createPayoutAttempt: boolean;
    })
  | { kind: "PATCH"; next: TransferRecord }
  | { kind: "NO_CHANGE" };

function sameIssue(a: Issue | null, b: Issue | null): boolean {
  if (a === null || b === null) return a === b;
  return a.code === b.code && a.message === b.message && a.retryable === b.retryable;
}

function patchOrNoChange(record: TransferRecord, patch: TransferPatch, now: Date): SettlementMapping {
  const s = { ...record.settlement, ...patch.settlement };
  const issue = patch.lastIssue !== undefined ? patch.lastIssue : record.lastIssue;
  if (s.status === record.settlement.status && s.txHash === record.settlement.txHash && sameIssue(issue, record.lastIssue)) {
    return { kind: "NO_CHANGE" };
  }
  return { kind: "PATCH", next: planPatch(record, patch, now) };
}

function review(record: TransferRecord, txHash: string | null, reason: string, now: Date): SettlementMapping {
  const planned = planTransition(
    record,
    "REVIEW_REQUIRED",
    {
      // Retain the last known hash; never erase evidence.
      settlement: { status: "REVIEW_REQUIRED", txHash: txHash ?? record.settlement.txHash },
      lastIssue: ISSUE_SETTLEMENT_REVIEW,
    },
    reason,
    now,
  );
  return { kind: "TRANSITION", createPayoutAttempt: false, ...planned };
}

/** Domain-level sanity check of evidence against the saved transfer. Part 4 does the full chain check. */
function evidenceProblem(record: TransferRecord, txHash: string, evidence: Evidence): string | null {
  if (record.settlement.txHash !== null && record.settlement.txHash !== txHash) return "CONFIRMED_HASH_MISMATCH";
  if (evidence.chainId !== SETTLEMENT_CHAIN_ID) return "EVIDENCE_CHAIN_MISMATCH";
  if (evidence.units !== formatAmount(record.amounts.settlementTokenUnits)) return "EVIDENCE_UNITS_MISMATCH";
  if (Number.isNaN(Date.parse(evidence.verifiedAt))) return "EVIDENCE_VERIFIED_AT_INVALID";
  return null;
}

/**
 * Map a settlement module result onto the transfer (plan section 4.3). Pure.
 * Only valid while the transfer is SETTLEMENT_PENDING; otherwise throws InvalidTransitionError.
 *
 * | Result        | Outcome                                                              |
 * | NOT_SUBMITTED | PATCH settlement PREPARING, lastIssue = issue ?? null                |
 * | PENDING       | PATCH settlement BROADCAST/PENDING + txHash, lastIssue = issue ?? null |
 * | CONFIRMED     | TRANSITION -> SETTLED (evidence, verifiedAt), createPayoutAttempt    |
 * | FAILED        | TRANSITION -> SETTLEMENT_FAILED, keep hash, verifiedAt null          |
 * | REVIEW        | TRANSITION -> REVIEW_REQUIRED, keep last known hash                  |
 *
 * Contradictions (a different hash than the one already saved, NOT_SUBMITTED after a hash
 * was saved, evidence for another chain/amount) are held as REVIEW_REQUIRED, never guessed.
 */
export function mapSettlementResult(record: TransferRecord, result: SettlementResult, now: Date): SettlementMapping {
  if (record.status !== "SETTLEMENT_PENDING") {
    const target =
      result.kind === "CONFIRMED" ? "SETTLED" : result.kind === "FAILED" ? "SETTLEMENT_FAILED" : result.kind === "REVIEW" ? "REVIEW_REQUIRED" : "SETTLEMENT_PENDING";
    throw new InvalidTransitionError(record.status, target, `cannot map settlement result ${result.kind} while ${record.status}`);
  }
  const savedHash = record.settlement.txHash;

  switch (result.kind) {
    case "NOT_SUBMITTED":
      if (savedHash !== null) return review(record, null, "SETTLEMENT_REGRESSED_AFTER_BROADCAST", now);
      return patchOrNoChange(record, { settlement: { status: "PREPARING" }, lastIssue: result.issue ?? null }, now);

    case "PENDING":
      if (savedHash !== null && savedHash !== result.txHash) return review(record, savedHash, "SETTLEMENT_HASH_CHANGED", now);
      return patchOrNoChange(
        record,
        { settlement: { status: result.phase, txHash: result.txHash }, lastIssue: result.issue ?? null },
        now,
      );

    case "CONFIRMED": {
      const problem = evidenceProblem(record, result.txHash, result.evidence);
      if (problem !== null) return review(record, savedHash ?? result.txHash, problem, now);
      const planned = planTransition(
        record,
        "SETTLED",
        {
          settlement: {
            status: "CONFIRMED",
            txHash: result.txHash,
            evidence: { ...result.evidence },
            verifiedAt: new Date(result.evidence.verifiedAt),
          },
          lastIssue: null,
        },
        "SETTLEMENT_CONFIRMED",
        now,
      );
      return { kind: "TRANSITION", createPayoutAttempt: true, ...planned };
    }

    case "FAILED": {
      if (savedHash !== null && savedHash !== result.txHash) return review(record, savedHash, "SETTLEMENT_HASH_CHANGED", now);
      const planned = planTransition(
        record,
        "SETTLEMENT_FAILED",
        {
          settlement: { status: "FAILED", txHash: result.txHash, evidence: null, verifiedAt: null },
          lastIssue: ISSUE_SETTLEMENT_REVERTED,
        },
        // Part 4's reason stays in the internal event log, not in the public snapshot.
        `SETTLEMENT_REVERTED: ${result.reason}`,
        now,
      );
      return { kind: "TRANSITION", createPayoutAttempt: false, ...planned };
    }

    case "REVIEW":
      return review(record, result.txHash, `SETTLEMENT_REVIEW: ${result.reason}`, now);
  }
}

/**
 * A thrown error / RPC outage from `settlement.step()`: status and substatus unchanged,
 * `lastIssue = DEPENDENCY_UNAVAILABLE` (plan section 4.3 last row). Caller releases the claim.
 */
export function mapSettlementError(record: TransferRecord, now: Date): SettlementMapping {
  if (sameIssue(record.lastIssue, ISSUE_DEPENDENCY_UNAVAILABLE)) return { kind: "NO_CHANGE" };
  return { kind: "PATCH", next: planPatch(record, { lastIssue: ISSUE_DEPENDENCY_UNAVAILABLE }, now) };
}
