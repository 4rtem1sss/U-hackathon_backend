import "server-only";
import type {
  Json,
  NewTransfer,
  TransferEventRow,
  TransferPatch as DbTransferPatch,
  TransferRow,
} from "@/db";
import type { Evidence, Receipt, TransferEvent, TransferRecord } from "@/domain";
import { parseAmount } from "@/lib/money";

/**
 * Row <-> domain mapping for transfers. DB rows carry amounts as strings and
 * jsonb as parsed JSON; the domain uses bigint amounts and Date timestamps.
 */

function fail(field: string): never {
  throw new Error(`transfer row has unexpected ${field}`);
}

function toDate(value: unknown, field: string): Date {
  const d = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  if (!d || Number.isNaN(d.getTime())) fail(field);
  return d;
}

function receiptFromJson(json: Json | null): Receipt | null {
  if (json === null) return null;
  if (typeof json !== "object" || Array.isArray(json)) fail("receipt");
  const { id, issuedAt, summary } = json;
  if (typeof id !== "string" || typeof summary !== "string") fail("receipt");
  return { id, issuedAt: toDate(issuedAt, "receipt.issuedAt"), summary };
}

/** `transfers` row -> domain record. Throws on data the schema should never allow. */
export function rowToRecord(row: TransferRow): TransferRecord {
  if (row.sourceCurrency !== "USD") fail("sourceCurrency");
  if (row.destinationCurrency !== "THB") fail("destinationCurrency");
  const r = row.recipientSnapshot;
  return {
    id: row.id,
    ownerId: row.ownerId,
    quoteId: row.quoteId,
    status: row.status,
    version: row.version,
    purpose: row.purpose,
    demoScenario: row.demoScenario,
    recipient: {
      id: r.id,
      name: r.name,
      bankLabel: r.bankLabel,
      accountDisplay: r.accountDisplay,
      isSynthetic: r.isSynthetic,
    },
    amounts: {
      sourceCurrency: "USD",
      destinationCurrency: "THB",
      sourceDebitMinor: parseAmount(row.sourceDebitMinor),
      feeMinor: parseAmount(row.feeMinor),
      conversionPrincipalMinor: parseAmount(row.conversionPrincipalMinor),
      destinationNetMinor: parseAmount(row.destinationNetMinor),
      settlementTokenUnits: parseAmount(row.settlementTokenUnits),
    },
    fx: {
      fixtureVersion: row.fixtureVersion,
      rateNumerator: parseAmount(row.fxRateNumerator),
      rateDenominator: parseAmount(row.fxRateDenominator),
    },
    funding: { status: row.fundingStatus, reference: row.fundingReference },
    settlement: {
      status: row.settlementStatus,
      txHash: row.settlementTxHash,
      evidence: (row.settlementEvidence as Evidence | null) ?? null,
      verifiedAt: row.settlementVerifiedAt === null ? null : toDate(row.settlementVerifiedAt, "settlementVerifiedAt"),
    },
    payout: { status: row.payoutStatus, reference: row.payoutReference },
    lastIssue: row.lastIssue,
    receipt: receiptFromJson(row.receipt),
    createdAt: toDate(row.createdAt, "createdAt"),
    updatedAt: toDate(row.updatedAt, "updatedAt"),
  };
}

/** `transfer_events` row -> domain event. */
export function eventRowToEvent(row: TransferEventRow): TransferEvent {
  return {
    sequence: row.sequence,
    fromStatus: row.fromStatus,
    toStatus: row.toStatus,
    reason: row.reason ?? "",
    createdAt: toDate(row.createdAt, "event.createdAt"),
  };
}

/** Domain record (from `newTransferRecord`) -> insert parameters. */
export function recordToNewTransfer(record: TransferRecord): NewTransfer {
  return {
    id: record.id,
    ownerId: record.ownerId,
    quoteId: record.quoteId,
    status: record.status,
    purpose: record.purpose,
    demoScenario: record.demoScenario,
    recipientSnapshot: { ...record.recipient },
    sourceCurrency: record.amounts.sourceCurrency,
    destinationCurrency: record.amounts.destinationCurrency,
    sourceDebitMinor: record.amounts.sourceDebitMinor,
    feeMinor: record.amounts.feeMinor,
    conversionPrincipalMinor: record.amounts.conversionPrincipalMinor,
    destinationNetMinor: record.amounts.destinationNetMinor,
    settlementTokenUnits: record.amounts.settlementTokenUnits,
    fxRateNumerator: record.fx.rateNumerator,
    fxRateDenominator: record.fx.rateDenominator,
    fixtureVersion: record.fx.fixtureVersion,
  };
}

/**
 * Every mutable column of a planned record, for `updateTransferWithVersion`.
 * Writing all of them (not a diff) keeps the stored row identical to the
 * record the domain validated.
 */
export function recordToPatch(record: TransferRecord): DbTransferPatch {
  return {
    status: record.status,
    fundingStatus: record.funding.status,
    fundingReference: record.funding.reference,
    settlementStatus: record.settlement.status,
    settlementTxHash: record.settlement.txHash,
    settlementEvidence: record.settlement.evidence === null ? null : { ...record.settlement.evidence },
    settlementVerifiedAt: record.settlement.verifiedAt,
    payoutStatus: record.payout.status,
    payoutReference: record.payout.reference,
    lastIssue: record.lastIssue,
    receipt:
      record.receipt === null
        ? null
        : { id: record.receipt.id, issuedAt: record.receipt.issuedAt.toISOString(), summary: record.receipt.summary },
  };
}
