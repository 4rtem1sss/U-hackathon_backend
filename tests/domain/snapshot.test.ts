import { describe, expect, it } from "vitest";
import { RECEIPT_SUMMARY, buildReceipt } from "@/domain/receipt";
import { explorerTxUrl, toSnapshot } from "@/domain/snapshot";
import { TRANSFER_STATUSES } from "@/domain/enums";
import { EVIDENCE, SNAPSHOT_CONFIG, TOKEN, TX_HASH, at, created, recordAt } from "./fixtures";

const RECIPIENT = {
  id: "recipient_demo_th_001",
  name: "Demo Recipient",
  bankLabel: "Demo Thai Bank",
  accountDisplay: "TEST ACCOUNT 0001",
  isSynthetic: true,
};
const AMOUNTS = {
  sourceCurrency: "USD",
  destinationCurrency: "THB",
  sourceDebitMinor: "1000",
  feeMinor: "20",
  conversionPrincipalMinor: "980",
  destinationNetMinor: "34300",
  settlementTokenUnits: "9800000",
};
const FX = { mode: "SIMULATED", fixtureVersion: "fixture-us-th-v1", rateNumerator: "35", rateDenominator: "1" };
/** Key order of the api-contract section 6 example. */
const TOP_KEYS = [
  "id", "quoteId", "status", "version", "mode", "purpose", "demoScenario", "recipient", "amounts", "funding", "fx",
  "settlement", "payout", "notification", "events", "lastIssue", "nextAction", "receipt", "createdAt", "updatedAt",
];
const iso = (d: Date) => d.toISOString();

function collectKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => collectKeys(v, out));
  else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      collectKeys(v, out);
    }
  }
  return out;
}

describe("toSnapshot()", () => {
  it("FUNDING_PENDING fixture: version 1, one event, SIMULATE_FUNDING, all refs null", () => {
    const { record, event } = created();
    const snap = toSnapshot(record, [event], SNAPSHOT_CONFIG);
    expect(snap).toEqual({
      id: "transfer_demo_001",
      quoteId: "quote_demo_001",
      status: "FUNDING_PENDING",
      version: 1,
      mode: "DEMO",
      purpose: "PERSONAL_REMITTANCE",
      demoScenario: "HAPPY_PATH",
      recipient: RECIPIENT,
      amounts: AMOUNTS,
      funding: { mode: "SIMULATED", status: "PENDING", reference: null },
      fx: FX,
      settlement: {
        mode: "TESTNET",
        status: "NOT_STARTED",
        chainId: 43113,
        tokenSymbol: "USDC",
        tokenAddress: TOKEN,
        tokenDecimals: 6,
        txHash: null,
        explorerUrl: null,
        verifiedAt: null,
      },
      payout: { mode: "SIMULATED", status: "NOT_STARTED", reference: null },
      notification: { channel: "NTFY", status: "NOT_STARTED", sentAt: null },
      events: [{ sequence: 1, status: "FUNDING_PENDING", createdAt: "2026-10-15T15:01:00.000Z" }],
      lastIssue: null,
      nextAction: "SIMULATE_FUNDING",
      receipt: null,
      createdAt: "2026-10-15T15:01:00.000Z",
      updatedAt: "2026-10-15T15:01:00.000Z",
    });
    expect(Object.keys(snap)).toEqual(TOP_KEYS);
  });

  it("SETTLEMENT_PENDING fixture matches the section 6 example shape", () => {
    const { record, events } = recordAt("SETTLEMENT_PENDING");
    const snap = toSnapshot(record, events, SNAPSHOT_CONFIG);
    expect(snap).toEqual({
      id: "transfer_demo_001",
      quoteId: "quote_demo_001",
      status: "SETTLEMENT_PENDING",
      version: 3,
      mode: "DEMO",
      purpose: "PERSONAL_REMITTANCE",
      demoScenario: "HAPPY_PATH",
      recipient: RECIPIENT,
      amounts: AMOUNTS,
      funding: { mode: "SIMULATED", status: "ACCEPTED", reference: "funding_demo_001" },
      fx: FX,
      settlement: {
        mode: "TESTNET",
        status: "PREPARING",
        chainId: 43113,
        tokenSymbol: "USDC",
        tokenAddress: TOKEN,
        tokenDecimals: 6,
        txHash: null,
        explorerUrl: null,
        verifiedAt: null,
      },
      payout: { mode: "SIMULATED", status: "NOT_STARTED", reference: null },
      notification: { channel: "NTFY", status: "NOT_STARTED", sentAt: null },
      events: [
        { sequence: 1, status: "FUNDING_PENDING", createdAt: iso(at(0)) },
        { sequence: 2, status: "FUNDED_SIMULATED", createdAt: iso(at(1)) },
        { sequence: 3, status: "SETTLEMENT_PENDING", createdAt: iso(at(2)) },
      ],
      lastIssue: null,
      nextAction: "ADVANCE",
      receipt: null,
      createdAt: iso(at(0)),
      updatedAt: iso(at(2)),
    });
    expect(Object.keys(snap)).toEqual(TOP_KEYS);
  });

  it("COMPLETED_SIMULATED fixture has evidence, payout reference and receipt", () => {
    const { record, events } = recordAt("COMPLETED_SIMULATED");
    const snap = toSnapshot(record, events, SNAPSHOT_CONFIG);
    expect(snap.status).toBe("COMPLETED_SIMULATED");
    expect(snap.version).toBe(6);
    expect(snap.nextAction).toBe("NONE");
    expect(snap.funding).toEqual({ mode: "SIMULATED", status: "ACCEPTED", reference: "funding_demo_001" });
    expect(snap.settlement).toEqual({
      mode: "TESTNET",
      status: "CONFIRMED",
      chainId: 43113,
      tokenSymbol: "USDC",
      tokenAddress: TOKEN,
      tokenDecimals: 6,
      txHash: TX_HASH,
      explorerUrl: `https://testnet.snowtrace.io/tx/${TX_HASH}`,
      verifiedAt: EVIDENCE.verifiedAt,
    });
    expect(snap.payout).toEqual({ mode: "SIMULATED", status: "PAID", reference: "payout_demo_001" });
    expect(snap.receipt).toEqual({ id: "receipt_demo_001", issuedAt: iso(at(20)), summary: RECEIPT_SUMMARY });
    expect(snap.events.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(snap.events.map((e) => e.status)).toEqual([
      "FUNDING_PENDING", "FUNDED_SIMULATED", "SETTLEMENT_PENDING", "SETTLED", "PAYOUT_PENDING", "COMPLETED_SIMULATED",
    ]);
    expect(Object.keys(snap)).toEqual(TOP_KEYS);
  });

  it("receipt is null for every status except COMPLETED_SIMULATED", () => {
    for (const status of TRANSFER_STATUSES) {
      const { record, events } = recordAt(status);
      const snap = toSnapshot(record, events, SNAPSHOT_CONFIG);
      expect(snap.receipt === null).toBe(status !== "COMPLETED_SIMULATED");
      expect(Object.keys(snap)).toEqual(TOP_KEYS);
    }
  });

  it("SETTLEMENT_FAILED keeps the hash/explorer URL but verifiedAt null", () => {
    const { record, events } = recordAt("SETTLEMENT_FAILED");
    const snap = toSnapshot(record, events, SNAPSHOT_CONFIG);
    expect(snap.settlement).toMatchObject({ status: "FAILED", txHash: TX_HASH, verifiedAt: null });
    expect(snap.settlement.explorerUrl).toBe(explorerTxUrl(TX_HASH));
    expect(snap.payout.status).toBe("NOT_STARTED");
    expect(snap.nextAction).toBe("NONE");
  });

  it("sorts events by sequence", () => {
    const { record, events } = recordAt("SETTLED");
    const snap = toSnapshot(record, [...events].reverse(), SNAPSHOT_CONFIG);
    expect(snap.events.map((e) => e.sequence)).toEqual([1, 2, 3, 4]);
  });

  it("uses a configurable explorer base URL", () => {
    const { record, events } = recordAt("SETTLED");
    const snap = toSnapshot(record, events, { ...SNAPSHOT_CONFIG, explorerBaseUrl: "https://explorer.example/fuji/" });
    expect(snap.settlement.explorerUrl).toBe(`https://explorer.example/fuji/tx/${TX_HASH}`);
  });

  it("never exposes secrets, raw evidence or internal fields", () => {
    const forbidden = /signed|privatekey|secret|rawtx|evidence|ownerid|blockhash|nonce|attempt|reason|fromstatus/i;
    for (const status of TRANSFER_STATUSES) {
      const { record, events } = recordAt(status);
      // even if a caller sneaks extra properties onto the record, they are not copied
      const polluted = { ...record, signedTx: "0xdead", privateKey: "0xbeef" } as typeof record;
      const snap = toSnapshot(polluted, events, SNAPSHOT_CONFIG);
      const keys = collectKeys(snap);
      expect(keys.filter((k) => forbidden.test(k))).toEqual([]);
      const json = JSON.stringify(snap);
      expect(json).not.toContain("0xdead");
      expect(json).not.toContain("0xbeef");
      expect(json).not.toContain(EVIDENCE.blockHash);
    }
  });
});

describe("buildReceipt()", () => {
  it("builds the fixed summary with a receipt ID", () => {
    const r = buildReceipt(at(5));
    expect(r.id).toMatch(/^rct_/);
    expect(r.issuedAt).toEqual(at(5));
    expect(r.summary).toBe("Demo completed: testnet settlement confirmed; THB payout simulated.");
  });
});
