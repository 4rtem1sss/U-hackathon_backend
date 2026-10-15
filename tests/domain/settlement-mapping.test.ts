import { describe, expect, it } from "vitest";
import {
  ISSUE_DEPENDENCY_UNAVAILABLE,
  ISSUE_SETTLEMENT_REVERTED,
  mapSettlementError,
  mapSettlementResult,
  type SettlementMapping,
} from "@/domain/settlement-mapping";
import type { TransferRecord } from "@/domain/transfer";
import { InvalidTransitionError, checkInvariants, planPatch } from "@/domain/transitions";
import { EVIDENCE, TX_HASH, at, recordAt } from "./fixtures";

const OTHER_HASH = "0x" + "ef".repeat(32);
const issue = { code: "RPC_TIMEOUT", message: "Settlement outcome is not confirmed yet.", retryable: true };
const now = at(100);

function pending(): TransferRecord {
  return recordAt("SETTLEMENT_PENDING").record;
}
function broadcast(): TransferRecord {
  return planPatch(pending(), { settlement: { status: "BROADCAST", txHash: TX_HASH } }, at(50));
}
function expectKind<K extends SettlementMapping["kind"]>(m: SettlementMapping, kind: K): Extract<SettlementMapping, { kind: K }> {
  expect(m.kind).toBe(kind);
  return m as Extract<SettlementMapping, { kind: K }>;
}

describe("mapSettlementResult()", () => {
  it("NOT_SUBMITTED with no change -> NO_CHANGE", () => {
    expect(mapSettlementResult(pending(), { kind: "NOT_SUBMITTED", attemptId: null }, now)).toEqual({ kind: "NO_CHANGE" });
  });

  it("NOT_SUBMITTED with an issue -> PATCH lastIssue, still PREPARING, version+1", () => {
    const r = pending();
    const m = expectKind(mapSettlementResult(r, { kind: "NOT_SUBMITTED", attemptId: "stl_1", issue }, now), "PATCH");
    expect(m.next.status).toBe("SETTLEMENT_PENDING");
    expect(m.next.settlement.status).toBe("PREPARING");
    expect(m.next.lastIssue).toEqual(issue);
    expect(m.next.version).toBe(r.version + 1);
  });

  it("NOT_SUBMITTED clears a stale issue", () => {
    const r = planPatch(pending(), { lastIssue: issue }, at(60));
    const m = expectKind(mapSettlementResult(r, { kind: "NOT_SUBMITTED", attemptId: "stl_1" }, now), "PATCH");
    expect(m.next.lastIssue).toBeNull();
  });

  it("NOT_SUBMITTED after a hash was saved -> REVIEW_REQUIRED keeping the hash", () => {
    const m = expectKind(mapSettlementResult(broadcast(), { kind: "NOT_SUBMITTED", attemptId: "stl_1" }, now), "TRANSITION");
    expect(m.next.status).toBe("REVIEW_REQUIRED");
    expect(m.next.settlement.txHash).toBe(TX_HASH);
  });

  it.each(["BROADCAST", "PENDING"] as const)("PENDING phase %s -> PATCH with txHash", (phase) => {
    const m = expectKind(mapSettlementResult(pending(), { kind: "PENDING", attemptId: "stl_1", txHash: TX_HASH, phase }, now), "PATCH");
    expect(m.next.status).toBe("SETTLEMENT_PENDING");
    expect(m.next.settlement).toMatchObject({ status: phase, txHash: TX_HASH, verifiedAt: null, evidence: null });
    expect(checkInvariants(m.next)).toEqual([]);
  });

  it("PENDING repeated with the same data -> NO_CHANGE", () => {
    expect(mapSettlementResult(broadcast(), { kind: "PENDING", attemptId: "stl_1", txHash: TX_HASH, phase: "BROADCAST" }, now)).toEqual({
      kind: "NO_CHANGE",
    });
  });

  it("PENDING with an issue sets lastIssue", () => {
    const m = expectKind(
      mapSettlementResult(broadcast(), { kind: "PENDING", attemptId: "stl_1", txHash: TX_HASH, phase: "PENDING", issue }, now),
      "PATCH",
    );
    expect(m.next.lastIssue).toEqual(issue);
    expect(m.next.settlement.status).toBe("PENDING");
  });

  it("PENDING with a different hash -> REVIEW_REQUIRED keeping the saved hash", () => {
    const m = expectKind(
      mapSettlementResult(broadcast(), { kind: "PENDING", attemptId: "stl_2", txHash: OTHER_HASH, phase: "PENDING" }, now),
      "TRANSITION",
    );
    expect(m.next.status).toBe("REVIEW_REQUIRED");
    expect(m.next.settlement.txHash).toBe(TX_HASH);
  });

  it("CONFIRMED -> SETTLED with evidence, verifiedAt and createPayoutAttempt", () => {
    const r = broadcast();
    const m = expectKind(mapSettlementResult(r, { kind: "CONFIRMED", attemptId: "stl_1", txHash: TX_HASH, evidence: EVIDENCE }, now), "TRANSITION");
    expect(m.createPayoutAttempt).toBe(true);
    expect(m.next.status).toBe("SETTLED");
    expect(m.next.settlement).toEqual({ status: "CONFIRMED", txHash: TX_HASH, evidence: EVIDENCE, verifiedAt: new Date(EVIDENCE.verifiedAt) });
    expect(m.next.payout.status).toBe("NOT_STARTED");
    expect(m.next.lastIssue).toBeNull();
    expect(m.next.version).toBe(r.version + 1);
    expect(m.event).toMatchObject({ fromStatus: "SETTLEMENT_PENDING", toStatus: "SETTLED" });
  });

  it("CONFIRMED straight from PREPARING is accepted", () => {
    const m = expectKind(mapSettlementResult(pending(), { kind: "CONFIRMED", attemptId: "stl_1", txHash: TX_HASH, evidence: EVIDENCE }, now), "TRANSITION");
    expect(m.next.status).toBe("SETTLED");
  });

  it.each([
    ["wrong chain", { ...EVIDENCE, chainId: 1 }, TX_HASH],
    ["wrong units", { ...EVIDENCE, units: "9800001" }, TX_HASH],
    ["bad verifiedAt", { ...EVIDENCE, verifiedAt: "not a date" }, TX_HASH],
    ["different hash than saved", EVIDENCE, OTHER_HASH],
  ])("CONFIRMED with %s -> REVIEW_REQUIRED, no payout", (_n, evidence, txHash) => {
    const m = expectKind(mapSettlementResult(broadcast(), { kind: "CONFIRMED", attemptId: "stl_1", txHash, evidence }, now), "TRANSITION");
    expect(m.next.status).toBe("REVIEW_REQUIRED");
    expect(m.createPayoutAttempt).toBe(false);
    expect(m.next.settlement.verifiedAt).toBeNull();
    expect(m.next.settlement.txHash).toBe(TX_HASH);
  });

  it("FAILED -> SETTLEMENT_FAILED keeping hash, verifiedAt null, payout NOT_STARTED", () => {
    const m = expectKind(mapSettlementResult(broadcast(), { kind: "FAILED", attemptId: "stl_1", txHash: TX_HASH, reason: "reverted at block 1" }, now), "TRANSITION");
    expect(m.next.status).toBe("SETTLEMENT_FAILED");
    expect(m.next.settlement).toEqual({ status: "FAILED", txHash: TX_HASH, evidence: null, verifiedAt: null });
    expect(m.next.payout).toEqual({ status: "NOT_STARTED", reference: null });
    expect(m.next.lastIssue).toEqual(ISSUE_SETTLEMENT_REVERTED);
    expect(m.event.reason).toContain("reverted at block 1");
    expect(m.createPayoutAttempt).toBe(false);
  });

  it("FAILED with a different hash -> REVIEW_REQUIRED", () => {
    const m = expectKind(mapSettlementResult(broadcast(), { kind: "FAILED", attemptId: "stl_1", txHash: OTHER_HASH, reason: "r" }, now), "TRANSITION");
    expect(m.next.status).toBe("REVIEW_REQUIRED");
  });

  it("REVIEW -> REVIEW_REQUIRED, nextAction-relevant hold, keeps hash", () => {
    const m = expectKind(mapSettlementResult(broadcast(), { kind: "REVIEW", attemptId: "stl_1", txHash: null, reason: "contradictory receipts" }, now), "TRANSITION");
    expect(m.next.status).toBe("REVIEW_REQUIRED");
    expect(m.next.settlement.status).toBe("REVIEW_REQUIRED");
    expect(m.next.settlement.txHash).toBe(TX_HASH);
    expect(m.next.lastIssue?.retryable).toBe(false);
  });

  it("REVIEW with no hash at all is valid", () => {
    const m = expectKind(mapSettlementResult(pending(), { kind: "REVIEW", attemptId: null, txHash: null, reason: "x" }, now), "TRANSITION");
    expect(m.next.settlement.txHash).toBeNull();
    expect(checkInvariants(m.next)).toEqual([]);
  });

  it.each(["FUNDED_SIMULATED", "SETTLED", "SETTLEMENT_FAILED", "REVIEW_REQUIRED", "COMPLETED_SIMULATED"] as const)(
    "throws InvalidTransitionError when the transfer is %s",
    (status) => {
      expect(() =>
        mapSettlementResult(recordAt(status).record, { kind: "CONFIRMED", attemptId: "stl_1", txHash: TX_HASH, evidence: EVIDENCE }, now),
      ).toThrow(InvalidTransitionError);
    },
  );
});

describe("mapSettlementError()", () => {
  it("sets lastIssue DEPENDENCY_UNAVAILABLE without changing status/substatus", () => {
    const r = broadcast();
    const m = expectKind(mapSettlementError(r, now), "PATCH");
    expect(m.next.status).toBe(r.status);
    expect(m.next.settlement).toEqual(r.settlement);
    expect(m.next.lastIssue).toEqual(ISSUE_DEPENDENCY_UNAVAILABLE);
    expect(m.next.version).toBe(r.version + 1);
  });

  it("is NO_CHANGE when the issue is already recorded", () => {
    const r = expectKind(mapSettlementError(broadcast(), now), "PATCH").next;
    expect(mapSettlementError(r, at(101))).toEqual({ kind: "NO_CHANGE" });
  });
});
