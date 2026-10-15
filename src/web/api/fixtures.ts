import type { Quote, TransferSnapshot, TransferStatus, NextAction } from "./types";

export const contractQuoteExample: Quote = {
  id: "quote_demo_001",
  recipientId: "recipient_demo_th_001",
  sourceCountry: "US",
  destinationCountry: "TH",
  sourceCurrency: "USD",
  destinationCurrency: "THB",
  sourceDebitMinor: "1000",
  feeMinor: "20",
  conversionPrincipalMinor: "980",
  fxRateNumerator: "35",
  fxRateDenominator: "1",
  destinationNetMinor: "34300",
  settlementTokenUnits: "9800000",
  fixtureVersion: "fixture-us-th-v1",
  createdAt: "2026-10-15T15:00:00Z",
  expiresAt: "2026-10-15T15:05:00Z",
  mode: "DEMO",
  fundingSimulated: true,
  fxSimulated: true,
  payoutSimulated: true,
  settlementMode: "TESTNET",
  chainId: 43113,
  arrivalEstimate: null,
};

export const contractSnapshotExample: TransferSnapshot = {
  id: "transfer_demo_001",
  quoteId: "quote_demo_001",
  status: "SETTLEMENT_PENDING",
  version: 3,
  mode: "DEMO",
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
    sourceDebitMinor: "1000",
    feeMinor: "20",
    conversionPrincipalMinor: "980",
    destinationNetMinor: "34300",
    settlementTokenUnits: "9800000",
  },
  funding: { mode: "SIMULATED", status: "ACCEPTED", reference: "funding_demo_001" },
  fx: { mode: "SIMULATED", fixtureVersion: "fixture-us-th-v1", rateNumerator: "35", rateDenominator: "1" },
  settlement: {
    mode: "TESTNET",
    status: "PREPARING",
    chainId: 43113,
    tokenSymbol: "USDC",
    tokenAddress: "0x5425890298aed601595a70AB815c96711a31Bc65",
    tokenDecimals: 6,
    txHash: null,
    explorerUrl: null,
    verifiedAt: null,
  },
  payout: { mode: "SIMULATED", status: "NOT_STARTED", reference: null },
  notification: { channel: "NTFY", status: "NOT_STARTED", sentAt: null },
  events: [
    { sequence: 1, status: "FUNDING_PENDING", createdAt: "2026-10-15T15:01:00Z" },
    { sequence: 2, status: "FUNDED_SIMULATED", createdAt: "2026-10-15T15:01:02Z" },
    { sequence: 3, status: "SETTLEMENT_PENDING", createdAt: "2026-10-15T15:01:03Z" },
  ],
  lastIssue: null,
  nextAction: "ADVANCE",
  receipt: null,
  createdAt: "2026-10-15T15:01:00Z",
  updatedAt: "2026-10-15T15:01:03Z",
};

type Patch = {
  status: TransferStatus;
  nextAction?: NextAction;
  version?: number;
  funding?: Partial<TransferSnapshot["funding"]>;
  settlement?: Partial<TransferSnapshot["settlement"]>;
  payout?: Partial<TransferSnapshot["payout"]>;
  lastIssue?: TransferSnapshot["lastIssue"];
  notification?: TransferSnapshot["notification"];
  receipt?: TransferSnapshot["receipt"];
};

/** Test helper: the contract example with a few fields changed. */
export function snapshotWith(patch: Patch): TransferSnapshot {
  const b = contractSnapshotExample;
  return {
    ...b,
    status: patch.status,
    nextAction: patch.nextAction ?? b.nextAction,
    version: patch.version ?? b.version,
    funding: { ...b.funding, ...patch.funding },
    settlement: { ...b.settlement, ...patch.settlement },
    payout: { ...b.payout, ...patch.payout },
    lastIssue: patch.lastIssue === undefined ? b.lastIssue : patch.lastIssue,
    notification: patch.notification ?? b.notification,
    receipt: patch.receipt === undefined ? b.receipt : patch.receipt,
  };
}
