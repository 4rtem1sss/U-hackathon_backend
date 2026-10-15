import type { TransferStatus } from "@/domain/enums";
import { buildReceipt } from "@/domain/receipt";
import type { Evidence } from "@/domain/settlement-types";
import { newTransferRecord, type TransferEvent, type TransferRecord } from "@/domain/transfer";
import { planTransition, type TransferPatch } from "@/domain/transitions";

export const T0 = new Date("2026-10-15T15:01:00Z");
export const at = (seconds: number): Date => new Date(T0.getTime() + seconds * 1000);

export const TX_HASH = "0x" + "ab".repeat(32);
export const TOKEN = "0x5425890298aed601595a70AB815c96711a31Bc65";
export const SNAPSHOT_CONFIG = { tokenAddress: TOKEN, tokenDecimals: 6 };

export const EVIDENCE: Evidence = {
  chainId: 43113,
  blockNumber: "123456",
  blockHash: "0x" + "cd".repeat(32),
  tokenAddress: TOKEN,
  from: "0x" + "11".repeat(20),
  to: "0x" + "22".repeat(20),
  units: "9800000",
  confirmations: 1,
  verifiedAt: "2026-10-15T15:01:10.000Z",
};

export function created(): { record: TransferRecord; event: TransferEvent } {
  return newTransferRecord(
    {
      id: "transfer_demo_001",
      ownerId: "owner_1",
      quoteId: "quote_demo_001",
      purpose: "PERSONAL_REMITTANCE",
      demoScenario: "HAPPY_PATH",
      recipient: {
        id: "recipient_demo_th_001",
        name: "Demo Recipient",
        bankLabel: "Demo Thai Bank",
        accountDisplay: "TEST ACCOUNT 0001",
        isSynthetic: true,
      },
      amounts: {
        sourceCurrency: "USD",
        destinationCurrency: "THB",
        sourceDebitMinor: 1000n,
        feeMinor: 20n,
        conversionPrincipalMinor: 980n,
        destinationNetMinor: 34300n,
        settlementTokenUnits: 9800000n,
      },
      fx: { fixtureVersion: "fixture-us-th-v1", rateNumerator: 35n, rateDenominator: 1n },
    },
    T0,
  );
}

/** The patch that makes each target status consistent when reached along the happy/failure paths. */
export const STEP_PATCH: Record<TransferStatus, TransferPatch> = {
  FUNDING_PENDING: {},
  FUNDED_SIMULATED: { funding: { status: "ACCEPTED", reference: "funding_demo_001" } },
  FUNDING_FAILED: { funding: { status: "DECLINED", reference: "funding_demo_001" } },
  SETTLEMENT_PENDING: { settlement: { status: "PREPARING" } },
  SETTLED: {
    settlement: { status: "CONFIRMED", txHash: TX_HASH, evidence: EVIDENCE, verifiedAt: new Date(EVIDENCE.verifiedAt) },
  },
  SETTLEMENT_FAILED: { settlement: { status: "FAILED", txHash: TX_HASH } },
  PAYOUT_PENDING: { payout: { status: "PENDING", reference: "payout_demo_001" } },
  PAYOUT_FAILED: { payout: { status: "FAILED" } },
  REVIEW_REQUIRED: { settlement: { status: "REVIEW_REQUIRED" } },
  COMPLETED_SIMULATED: { payout: { status: "PAID" }, receipt: buildReceipt(at(20), "receipt_demo_001") },
};

/** Path from FUNDING_PENDING to each status. */
export const PATHS: Record<TransferStatus, TransferStatus[]> = {
  FUNDING_PENDING: [],
  FUNDED_SIMULATED: ["FUNDED_SIMULATED"],
  FUNDING_FAILED: ["FUNDING_FAILED"],
  SETTLEMENT_PENDING: ["FUNDED_SIMULATED", "SETTLEMENT_PENDING"],
  SETTLED: ["FUNDED_SIMULATED", "SETTLEMENT_PENDING", "SETTLED"],
  SETTLEMENT_FAILED: ["FUNDED_SIMULATED", "SETTLEMENT_PENDING", "SETTLEMENT_FAILED"],
  PAYOUT_PENDING: ["FUNDED_SIMULATED", "SETTLEMENT_PENDING", "SETTLED", "PAYOUT_PENDING"],
  PAYOUT_FAILED: ["FUNDED_SIMULATED", "SETTLEMENT_PENDING", "SETTLED", "PAYOUT_PENDING", "PAYOUT_FAILED"],
  REVIEW_REQUIRED: ["FUNDED_SIMULATED", "SETTLEMENT_PENDING", "REVIEW_REQUIRED"],
  COMPLETED_SIMULATED: ["FUNDED_SIMULATED", "SETTLEMENT_PENDING", "SETTLED", "PAYOUT_PENDING", "COMPLETED_SIMULATED"],
};

/** Walk the path with valid transitions; returns the record and all events (sequences assigned). */
export function recordAt(status: TransferStatus): { record: TransferRecord; events: TransferEvent[] } {
  const init = created();
  let record = init.record;
  const events: TransferEvent[] = [init.event];
  PATHS[status].forEach((to, i) => {
    const planned = planTransition(record, to, STEP_PATCH[to], `TO_${to}`, at(i + 1));
    record = planned.next;
    events.push({ ...planned.event, sequence: events.length + 1 });
  });
  return { record, events };
}
