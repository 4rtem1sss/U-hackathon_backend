import { describe, expect, it } from "vitest";
import type { TransferRow } from "@/db/types";
import { buildReceipt, newTransferRecord, planTransition } from "@/domain";
import { ApiError } from "@/lib/errors";
import { canonicalJson, fingerprint, requireIdempotencyKey } from "@/server/idempotency";
import { recordToNewTransfer, recordToPatch, rowToRecord } from "@/server/mapping";
import { createTransferBody } from "@/server/transfers";
import { fundingBody } from "@/server/funding";
import { simulateFunding } from "@/simulators/funding";

describe("idempotency helpers", () => {
  it("canonicalJson sorts keys recursively", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { y: 1, x: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[2,{"x":2,"y":1}]},"b":1}',
    );
  });

  it("fingerprint is key-order independent and includes the transferId", () => {
    const a = fingerprint("CREATE_TRANSFER", { quoteId: "q", purpose: "P", demoScenario: "H" });
    const b = fingerprint("CREATE_TRANSFER", { demoScenario: "H", purpose: "P", quoteId: "q" });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint("FUNDING", {}, "tr_1")).not.toBe(fingerprint("FUNDING", {}, "tr_2"));
    expect(fingerprint("FUNDING", {}, "tr_1")).not.toBe(fingerprint("PAYOUT_RETRY", {}, "tr_1"));
  });

  it("requireIdempotencyKey accepts UUIDs only", () => {
    const req = (v?: string) => new Request("http://x/", v ? { headers: { "idempotency-key": v } } : {});
    expect(requireIdempotencyKey(req("3F2B6C1E-1A2B-4C3D-8E9F-0A1B2C3D4E5F"))).toBe(
      "3f2b6c1e-1a2b-4c3d-8e9f-0a1b2c3d4e5f",
    );
    for (const bad of [undefined, "", "abc", "3f2b6c1e1a2b4c3d8e9f0a1b2c3d4e5f"]) {
      expect(() => requireIdempotencyKey(req(bad))).toThrowError(ApiError);
    }
  });
});

describe("request schemas", () => {
  it("create body is strict", () => {
    const ok = { quoteId: "qt_1", purpose: "PERSONAL_REMITTANCE", demoScenario: "HAPPY_PATH" };
    expect(createTransferBody.safeParse(ok).success).toBe(true);
    expect(createTransferBody.safeParse({ ...ok, amount: "1" }).success).toBe(false);
    expect(createTransferBody.safeParse({ ...ok, purpose: "GIFT" }).success).toBe(false);
  });
  it("funding body must be {}", () => {
    expect(fundingBody.safeParse({}).success).toBe(true);
    expect(fundingBody.safeParse({ status: "X" }).success).toBe(false);
  });
});

describe("funding simulator", () => {
  it("is deterministic by scenario", () => {
    expect(simulateFunding({ transferId: "tr_1", demoScenario: "HAPPY_PATH" })).toEqual({
      outcome: "ACCEPTED",
      reference: "funding_sim_tr_1",
    });
    expect(simulateFunding({ transferId: "tr_1", demoScenario: "PAYOUT_FAILED" }).outcome).toBe("ACCEPTED");
    expect(simulateFunding({ transferId: "tr_1", demoScenario: "FUNDING_DECLINED" }).outcome).toBe("DECLINED");
  });
});

describe("mapping", () => {
  const now = new Date("2026-10-15T15:00:00Z");
  const { record } = newTransferRecord(
    {
      id: "tr_1",
      ownerId: "own_1",
      quoteId: "qt_1",
      purpose: "PERSONAL_REMITTANCE",
      demoScenario: "HAPPY_PATH",
      recipient: { id: "rcp_1", name: "N", bankLabel: "B", accountDisplay: "A", isSynthetic: true },
      amounts: {
        sourceCurrency: "USD",
        destinationCurrency: "THB",
        sourceDebitMinor: 1000n,
        feeMinor: 20n,
        conversionPrincipalMinor: 980n,
        destinationNetMinor: 34300n,
        settlementTokenUnits: 98000000000000000000000000000000000000n,
      },
      fx: { fixtureVersion: "f1", rateNumerator: 35n, rateDenominator: 1n },
    },
    now,
  );

  function asRow(): TransferRow {
    const n = recordToNewTransfer(record);
    return {
      ...n,
      status: record.status,
      version: record.version,
      sourceDebitMinor: String(n.sourceDebitMinor),
      feeMinor: String(n.feeMinor),
      conversionPrincipalMinor: String(n.conversionPrincipalMinor),
      destinationNetMinor: String(n.destinationNetMinor),
      settlementTokenUnits: String(n.settlementTokenUnits),
      fxRateNumerator: String(n.fxRateNumerator),
      fxRateDenominator: String(n.fxRateDenominator),
      fundingStatus: "PENDING",
      fundingReference: null,
      settlementStatus: "NOT_STARTED",
      settlementTxHash: null,
      settlementEvidence: null,
      settlementVerifiedAt: null,
      payoutStatus: "NOT_STARTED",
      payoutReference: null,
      lastIssue: null,
      receipt: null,
      claimEpoch: 0,
      claimExpiresAt: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  it("rowToRecord round-trips a new record (bigint amounts, no float loss)", () => {
    expect(rowToRecord(asRow())).toEqual(record);
  });

  it("recordToPatch serializes receipt dates and evidence as JSON", () => {
    const funded = planTransition(record, "FUNDED_SIMULATED", { funding: { status: "ACCEPTED", reference: "f" } }, "x", now).next;
    const patch = recordToPatch({ ...funded, receipt: buildReceipt(now, "rct_1") });
    expect(patch).toMatchObject({
      status: "FUNDED_SIMULATED",
      fundingStatus: "ACCEPTED",
      fundingReference: "f",
      receipt: { id: "rct_1", issuedAt: "2026-10-15T15:00:00.000Z" },
    });
    const back = rowToRecord({ ...asRow(), receipt: patch.receipt ?? null });
    expect(back.receipt?.issuedAt).toEqual(now);
  });

  it("rowToRecord rejects an unsupported corridor", () => {
    expect(() => rowToRecord({ ...asRow(), sourceCurrency: "EUR" })).toThrow();
  });
});
