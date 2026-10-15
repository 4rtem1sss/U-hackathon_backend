import { formatAmount } from "@/lib/money";
import type {
  DemoScenario,
  FundingSubstatus,
  NextAction,
  PayoutSubstatus,
  Purpose,
  SettlementSubstatus,
  TransferStatus,
} from "./enums";
import type { Issue } from "./settlement-types";
import { SETTLEMENT_CHAIN_ID } from "./settlement-mapping";
import type { TransferEvent, TransferRecord } from "./transfer";
import { nextActionFor } from "./transitions";

/** Public transfer snapshot, exactly the api-contract section 6 `data` shape. */
export interface TransferSnapshot {
  id: string;
  quoteId: string;
  status: TransferStatus;
  version: number;
  mode: "DEMO";
  purpose: Purpose;
  demoScenario: DemoScenario;
  recipient: { id: string; name: string; bankLabel: string; accountDisplay: string; isSynthetic: boolean };
  amounts: {
    sourceCurrency: "USD";
    destinationCurrency: "THB";
    sourceDebitMinor: string;
    feeMinor: string;
    conversionPrincipalMinor: string;
    destinationNetMinor: string;
    settlementTokenUnits: string;
  };
  funding: { mode: "SIMULATED"; status: FundingSubstatus; reference: string | null };
  fx: { mode: "SIMULATED"; fixtureVersion: string; rateNumerator: string; rateDenominator: string };
  settlement: {
    mode: "TESTNET";
    status: SettlementSubstatus;
    chainId: number;
    tokenSymbol: "USDC";
    tokenAddress: string;
    tokenDecimals: number;
    txHash: string | null;
    explorerUrl: string | null;
    verifiedAt: string | null;
  };
  payout: { mode: "SIMULATED"; status: PayoutSubstatus; reference: string | null };
  events: { sequence: number; status: TransferStatus; createdAt: string }[];
  lastIssue: Issue | null;
  nextAction: NextAction;
  receipt: { id: string; issuedAt: string; summary: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface SnapshotConfig {
  /** Test USDC contract on Fuji (from server config, never from the client). */
  tokenAddress: string;
  tokenDecimals: number;
  /** Explorer base, e.g. "https://testnet.snowtrace.io"; the tx URL is `<base>/tx/<hash>`. */
  explorerBaseUrl?: string;
}

export const DEFAULT_EXPLORER_BASE_URL = "https://testnet.snowtrace.io";

export function explorerTxUrl(txHash: string, baseUrl: string = DEFAULT_EXPLORER_BASE_URL): string {
  return `${baseUrl.replace(/\/+$/, "")}/tx/${txHash}`;
}

/**
 * Build the public snapshot. Every key is set explicitly (no spreading of domain objects),
 * so internal data such as raw evidence, owner ID or signed bytes can never leak.
 */
export function toSnapshot(record: TransferRecord, events: readonly TransferEvent[], config: SnapshotConfig): TransferSnapshot {
  const { amounts, fx, settlement, receipt, lastIssue } = record;
  return {
    id: record.id,
    quoteId: record.quoteId,
    status: record.status,
    version: record.version,
    mode: "DEMO",
    purpose: record.purpose,
    demoScenario: record.demoScenario,
    recipient: {
      id: record.recipient.id,
      name: record.recipient.name,
      bankLabel: record.recipient.bankLabel,
      accountDisplay: record.recipient.accountDisplay,
      isSynthetic: record.recipient.isSynthetic,
    },
    amounts: {
      sourceCurrency: amounts.sourceCurrency,
      destinationCurrency: amounts.destinationCurrency,
      sourceDebitMinor: formatAmount(amounts.sourceDebitMinor),
      feeMinor: formatAmount(amounts.feeMinor),
      conversionPrincipalMinor: formatAmount(amounts.conversionPrincipalMinor),
      destinationNetMinor: formatAmount(amounts.destinationNetMinor),
      settlementTokenUnits: formatAmount(amounts.settlementTokenUnits),
    },
    funding: { mode: "SIMULATED", status: record.funding.status, reference: record.funding.reference },
    fx: {
      mode: "SIMULATED",
      fixtureVersion: fx.fixtureVersion,
      rateNumerator: formatAmount(fx.rateNumerator),
      rateDenominator: formatAmount(fx.rateDenominator),
    },
    settlement: {
      mode: "TESTNET",
      status: settlement.status,
      chainId: SETTLEMENT_CHAIN_ID,
      tokenSymbol: "USDC",
      tokenAddress: config.tokenAddress,
      tokenDecimals: config.tokenDecimals,
      txHash: settlement.txHash,
      explorerUrl: settlement.txHash === null ? null : explorerTxUrl(settlement.txHash, config.explorerBaseUrl),
      verifiedAt: settlement.verifiedAt === null ? null : settlement.verifiedAt.toISOString(),
    },
    payout: { mode: "SIMULATED", status: record.payout.status, reference: record.payout.reference },
    events: [...events]
      .sort((a, b) => a.sequence - b.sequence)
      .map((e) => ({ sequence: e.sequence, status: e.toStatus, createdAt: e.createdAt.toISOString() })),
    lastIssue: lastIssue === null ? null : { code: lastIssue.code, message: lastIssue.message, retryable: lastIssue.retryable },
    nextAction: nextActionFor(record.status),
    receipt:
      record.status === "COMPLETED_SIMULATED" && receipt !== null
        ? { id: receipt.id, issuedAt: receipt.issuedAt.toISOString(), summary: receipt.summary }
        : null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}
