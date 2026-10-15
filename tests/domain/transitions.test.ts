import { describe, expect, it } from "vitest";
import { TRANSFER_STATUSES, type TransferStatus } from "@/domain/enums";
import {
  ALLOWED_TRANSITIONS,
  InvalidTransitionError,
  TransferInvariantError,
  assertInvariants,
  canTransition,
  checkInvariants,
  domainErrorToApiError,
  invalidTransitionToApiError,
  isTerminalStatus,
  nextActionFor,
  planPatch,
  planTransition,
} from "@/domain/transitions";
import { ApiError } from "@/lib/errors";
import { EVIDENCE, STEP_PATCH, TX_HASH, at, created, recordAt } from "./fixtures";
import type { TransferRecord } from "@/domain/transfer";

const ALLOWED: [TransferStatus, TransferStatus][] = [
  ["FUNDING_PENDING", "FUNDED_SIMULATED"],
  ["FUNDING_PENDING", "FUNDING_FAILED"],
  ["FUNDED_SIMULATED", "SETTLEMENT_PENDING"],
  ["SETTLEMENT_PENDING", "SETTLED"],
  ["SETTLEMENT_PENDING", "SETTLEMENT_FAILED"],
  ["SETTLEMENT_PENDING", "REVIEW_REQUIRED"],
  ["SETTLED", "PAYOUT_PENDING"],
  ["PAYOUT_PENDING", "COMPLETED_SIMULATED"],
  ["PAYOUT_PENDING", "PAYOUT_FAILED"],
  ["PAYOUT_PENDING", "REVIEW_REQUIRED"],
  ["PAYOUT_FAILED", "PAYOUT_PENDING"],
];
const key = (a: string, b: string) => `${a}->${b}`;
const allowedKeys = new Set(ALLOWED.map(([a, b]) => key(a, b)));
const FORBIDDEN: [TransferStatus, TransferStatus][] = TRANSFER_STATUSES.flatMap((from) =>
  TRANSFER_STATUSES.filter((to) => !allowedKeys.has(key(from, to))).map((to) => [from, to] as [TransferStatus, TransferStatus]),
);

/** Patch that makes a transition into `to` consistent from `from`. */
function patchFor(from: TransferStatus, to: TransferStatus) {
  if (from === "PAYOUT_FAILED" && to === "PAYOUT_PENDING") return { payout: { status: "PENDING" as const, reference: "payout_demo_002" } };
  if (from === "PAYOUT_PENDING" && to === "REVIEW_REQUIRED") return { payout: { status: "UNKNOWN" as const } };
  if (from === "PAYOUT_PENDING" && to === "PAYOUT_FAILED") return STEP_PATCH.PAYOUT_FAILED;
  return STEP_PATCH[to];
}

describe("transition table", () => {
  it("matches the contract exactly", () => {
    const table = Object.entries(ALLOWED_TRANSITIONS).flatMap(([from, tos]) => tos.map((to) => key(from, to)));
    expect(new Set(table)).toEqual(allowedKeys);
    expect(FORBIDDEN.length + ALLOWED.length).toBe(100);
  });

  it.each(ALLOWED)("allows %s -> %s and plans version+1 with an event", (from, to) => {
    const { record } = recordAt(from);
    expect(canTransition(from, to)).toBe(true);
    const now = at(100);
    const { next, event } = planTransition(record, to, patchFor(from, to), "TEST", now);
    expect(next.status).toBe(to);
    expect(next.version).toBe(record.version + 1);
    expect(next.updatedAt).toEqual(now);
    expect(event).toEqual({ fromStatus: from, toStatus: to, reason: "TEST", createdAt: now });
    expect(checkInvariants(next)).toEqual([]);
    // the input record is not mutated
    expect(record.status).toBe(from);
  });

  it.each(FORBIDDEN)("rejects %s -> %s", (from, to) => {
    const { record } = recordAt(from);
    expect(canTransition(from, to)).toBe(false);
    let thrown: unknown;
    try {
      planTransition(record, to, STEP_PATCH[to], "TEST", at(100));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(InvalidTransitionError);
    expect((thrown as InvalidTransitionError).from).toBe(from);
    expect((thrown as InvalidTransitionError).to).toBe(to);
  });

  it("PAYOUT_FAILED -> PAYOUT_PENDING -> COMPLETED_SIMULATED via retry keeps settlement evidence", () => {
    const { record } = recordAt("PAYOUT_FAILED");
    const retry = planTransition(record, "PAYOUT_PENDING", patchFor("PAYOUT_FAILED", "PAYOUT_PENDING"), "RETRY", at(50)).next;
    const done = planTransition(retry, "COMPLETED_SIMULATED", STEP_PATCH.COMPLETED_SIMULATED, "PAID", at(51)).next;
    expect(done.settlement.txHash).toBe(TX_HASH);
    expect(done.settlement.evidence).toEqual(EVIDENCE);
    expect(done.payout).toEqual({ status: "PAID", reference: "payout_demo_002" });
  });
});

describe("nextActionFor()", () => {
  it.each<[TransferStatus, string]>([
    ["FUNDING_PENDING", "SIMULATE_FUNDING"],
    ["FUNDED_SIMULATED", "ADVANCE"],
    ["FUNDING_FAILED", "NONE"],
    ["SETTLEMENT_PENDING", "ADVANCE"],
    ["SETTLED", "ADVANCE"],
    ["SETTLEMENT_FAILED", "NONE"],
    ["PAYOUT_PENDING", "ADVANCE"],
    ["PAYOUT_FAILED", "RETRY_PAYOUT"],
    ["REVIEW_REQUIRED", "NONE"],
    ["COMPLETED_SIMULATED", "NONE"],
  ])("%s -> %s", (status, action) => {
    expect(nextActionFor(status)).toBe(action);
  });

  it("terminal statuses are exactly those with no outgoing transition", () => {
    expect(TRANSFER_STATUSES.filter(isTerminalStatus).sort()).toEqual(
      ["COMPLETED_SIMULATED", "FUNDING_FAILED", "REVIEW_REQUIRED", "SETTLEMENT_FAILED"].sort(),
    );
  });
});

describe("errors", () => {
  it("maps InvalidTransitionError to 409 INVALID_STATE", () => {
    const api = invalidTransitionToApiError(new InvalidTransitionError("FUNDING_FAILED", "SETTLED"));
    expect(api).toBeInstanceOf(ApiError);
    expect(api.code).toBe("INVALID_STATE");
    expect(api.status).toBe(409);
    expect(domainErrorToApiError(new InvalidTransitionError("FUNDING_FAILED", "SETTLED"))?.code).toBe("INVALID_STATE");
  });

  it("maps invariant errors to 500 and ignores unrelated errors", () => {
    expect(domainErrorToApiError(new TransferInvariantError("SETTLED", ["x"]))?.status).toBe(500);
    expect(domainErrorToApiError(new Error("x"))).toBeNull();
  });
});

describe("invariants per snapshot variant", () => {
  it.each(TRANSFER_STATUSES)("a record reached validly at %s has no violations", (status) => {
    expect(checkInvariants(recordAt(status).record)).toEqual([]);
  });

  it("newly created record: version 1, all refs null", () => {
    const { record, event } = created();
    expect(record.version).toBe(1);
    expect(event).toMatchObject({ sequence: 1, fromStatus: null, toStatus: "FUNDING_PENDING" });
    expect(checkInvariants(record)).toEqual([]);
  });

  const broken: [string, TransferStatus, (r: TransferRecord) => TransferRecord][] = [
    ["FUNDING_PENDING with funding reference", "FUNDING_PENDING", (r) => ({ ...r, funding: { status: "PENDING", reference: "f" } })],
    ["FUNDED_SIMULATED without funding reference", "FUNDED_SIMULATED", (r) => ({ ...r, funding: { status: "ACCEPTED", reference: null } })],
    ["FUNDING_FAILED with funding ACCEPTED", "FUNDING_FAILED", (r) => ({ ...r, funding: { ...r.funding, status: "ACCEPTED" } })],
    ["FUNDED_SIMULATED with a tx hash", "FUNDED_SIMULATED", (r) => ({ ...r, settlement: { ...r.settlement, txHash: TX_HASH } })],
    ["SETTLEMENT_PENDING PREPARING with hash", "SETTLEMENT_PENDING", (r) => ({ ...r, settlement: { ...r.settlement, txHash: TX_HASH } })],
    ["SETTLEMENT_PENDING BROADCAST without hash", "SETTLEMENT_PENDING", (r) => ({ ...r, settlement: { ...r.settlement, status: "BROADCAST" } })],
    ["SETTLEMENT_PENDING with NOT_STARTED settlement", "SETTLEMENT_PENDING", (r) => ({ ...r, settlement: { ...r.settlement, status: "NOT_STARTED" } })],
    ["SETTLED without verifiedAt", "SETTLED", (r) => ({ ...r, settlement: { ...r.settlement, verifiedAt: null } })],
    ["SETTLED without txHash", "SETTLED", (r) => ({ ...r, settlement: { ...r.settlement, txHash: null } })],
    ["SETTLED without evidence", "SETTLED", (r) => ({ ...r, settlement: { ...r.settlement, evidence: null } })],
    ["SETTLED with payout started", "SETTLED", (r) => ({ ...r, payout: { status: "PENDING", reference: "p" } })],
    ["SETTLEMENT_FAILED without hash", "SETTLEMENT_FAILED", (r) => ({ ...r, settlement: { ...r.settlement, txHash: null } })],
    ["SETTLEMENT_FAILED with verifiedAt", "SETTLEMENT_FAILED", (r) => ({ ...r, settlement: { ...r.settlement, verifiedAt: new Date() } })],
    ["SETTLEMENT_FAILED with payout", "SETTLEMENT_FAILED", (r) => ({ ...r, payout: { status: "PENDING", reference: "p" } })],
    ["PAYOUT_PENDING with payout PAID", "PAYOUT_PENDING", (r) => ({ ...r, payout: { ...r.payout, status: "PAID" } })],
    ["PAYOUT_FAILED without payout reference", "PAYOUT_FAILED", (r) => ({ ...r, payout: { ...r.payout, reference: null } })],
    ["PAYOUT_FAILED with settlement evidence erased", "PAYOUT_FAILED", (r) => ({ ...r, settlement: { status: "FAILED", txHash: TX_HASH, evidence: null, verifiedAt: null } })],
    ["COMPLETED_SIMULATED without receipt", "COMPLETED_SIMULATED", (r) => ({ ...r, receipt: null })],
    ["COMPLETED_SIMULATED with payout FAILED", "COMPLETED_SIMULATED", (r) => ({ ...r, payout: { ...r.payout, status: "FAILED" } })],
    ["receipt before completion", "PAYOUT_PENDING", (r) => ({ ...r, receipt: { id: "r", issuedAt: new Date(), summary: "s" } })],
    ["REVIEW_REQUIRED with settlement PENDING", "REVIEW_REQUIRED", (r) => ({ ...r, settlement: { ...r.settlement, status: "PENDING", txHash: TX_HASH } })],
    ["version 0", "FUNDING_PENDING", (r) => ({ ...r, version: 0 })],
    ["updatedAt before createdAt", "FUNDING_PENDING", (r) => ({ ...r, updatedAt: new Date(r.createdAt.getTime() - 1) })],
    ["negative amount", "FUNDING_PENDING", (r) => ({ ...r, amounts: { ...r.amounts, feeMinor: -1n } })],
  ];

  it.each(broken)("rejects %s", (_name, status, mutate) => {
    const bad = mutate(recordAt(status).record);
    expect(checkInvariants(bad).length).toBeGreaterThan(0);
    expect(() => assertInvariants(bad)).toThrow(TransferInvariantError);
  });

  it("REVIEW_REQUIRED from payout keeps the verified settlement", () => {
    const { record } = recordAt("PAYOUT_PENDING");
    const { next } = planTransition(record, "REVIEW_REQUIRED", { payout: { status: "UNKNOWN" } }, "PAYOUT_REVIEW", at(60));
    expect(next.settlement.status).toBe("CONFIRMED");
    expect(next.settlement.verifiedAt).not.toBeNull();
    // erasing evidence in a payout review is rejected
    expect(() =>
      planTransition(record, "REVIEW_REQUIRED", { settlement: { status: "REVIEW_REQUIRED", evidence: null, verifiedAt: null }, payout: { status: "UNKNOWN" } }, "X", at(60)),
    ).toThrow(TransferInvariantError);
  });

  it("planTransition rejects an inconsistent patch", () => {
    const { record } = recordAt("SETTLEMENT_PENDING");
    expect(() => planTransition(record, "SETTLED", { settlement: { status: "CONFIRMED", txHash: TX_HASH } }, "X", at(9))).toThrow(
      TransferInvariantError,
    );
    expect(() => planTransition(recordAt("PAYOUT_PENDING").record, "COMPLETED_SIMULATED", { payout: { status: "PAID" } }, "X", at(9))).toThrow(
      TransferInvariantError,
    );
  });
});

describe("planPatch()", () => {
  it("bumps version and updatedAt without changing status", () => {
    const { record } = recordAt("SETTLEMENT_PENDING");
    const next = planPatch(record, { settlement: { status: "BROADCAST", txHash: TX_HASH } }, at(30));
    expect(next.status).toBe("SETTLEMENT_PENDING");
    expect(next.version).toBe(record.version + 1);
    expect(next.updatedAt).toEqual(at(30));
    expect(next.settlement.txHash).toBe(TX_HASH);
  });

  it("enforces invariants", () => {
    expect(() => planPatch(recordAt("SETTLEMENT_PENDING").record, { settlement: { status: "CONFIRMED" } }, at(30))).toThrow(
      TransferInvariantError,
    );
  });
});
