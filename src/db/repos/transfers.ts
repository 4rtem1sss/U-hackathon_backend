import "server-only";
import type pg from "pg";
import { StaleFenceError } from "../errors";
import { jsonParam, mapRow } from "../map";
import { getPool, type Queryable } from "../pool";
import type {
  AmountString,
  DemoScenario,
  FundingSubstatus,
  Issue,
  Json,
  NotificationStatus,
  PayoutSubstatus,
  Purpose,
  RecipientSnapshot,
  SettlementSubstatus,
  TransferRow,
  TransferStatus,
} from "../types";

/**
 * Claim fence (plan 4.4). Structurally identical to `Fence` in
 * src/settlement/contract.ts (T6); defined here so the DB layer has no
 * dependency on the settlement module.
 */
export interface Fence {
  transferId: string;
  epoch: number;
}

type AmountInput = AmountString | bigint;

export interface NewTransfer {
  id: string;
  ownerId: string;
  quoteId: string;
  /** Default FUNDING_PENDING. */
  status?: TransferStatus;
  purpose: Purpose;
  demoScenario: DemoScenario;
  recipientSnapshot: RecipientSnapshot;
  sourceCurrency: string;
  destinationCurrency: string;
  sourceDebitMinor: AmountInput;
  feeMinor: AmountInput;
  conversionPrincipalMinor: AmountInput;
  destinationNetMinor: AmountInput;
  settlementTokenUnits: AmountInput;
  fxRateNumerator: AmountInput;
  fxRateDenominator: AmountInput;
  fixtureVersion: string;
}

/** Mutable columns. Amounts, recipient, scenario, owner and quote are immutable. */
export interface TransferPatch {
  status?: TransferStatus;
  fundingStatus?: FundingSubstatus;
  fundingReference?: string | null;
  settlementStatus?: SettlementSubstatus;
  settlementTxHash?: string | null;
  settlementEvidence?: Json | null;
  settlementVerifiedAt?: Date | null;
  payoutStatus?: PayoutSubstatus;
  payoutReference?: string | null;
  notificationStatus?: NotificationStatus;
  notificationSentAt?: Date | null;
  lastIssue?: Issue | null;
  receipt?: Json | null;
}

const PATCH_COLUMNS: Record<keyof TransferPatch, { column: string; json?: true }> = {
  status: { column: "status" },
  fundingStatus: { column: "funding_status" },
  fundingReference: { column: "funding_reference" },
  settlementStatus: { column: "settlement_status" },
  settlementTxHash: { column: "settlement_tx_hash" },
  settlementEvidence: { column: "settlement_evidence", json: true },
  settlementVerifiedAt: { column: "settlement_verified_at" },
  payoutStatus: { column: "payout_status" },
  payoutReference: { column: "payout_reference" },
  notificationStatus: { column: "notification_status" },
  notificationSentAt: { column: "notification_sent_at" },
  lastIssue: { column: "last_issue", json: true },
  receipt: { column: "receipt", json: true },
};

const toRow = (r: Record<string, unknown>) => mapRow<TransferRow>(r);

/** Insert a new transfer (version 1). Throws unique_violation on a reused quote ID. */
export async function insertTransfer(db: Queryable, t: NewTransfer): Promise<TransferRow> {
  const { rows } = await db.query(
    `INSERT INTO transfers (
       id, owner_id, quote_id, status, purpose, demo_scenario, recipient_snapshot,
       source_currency, destination_currency, source_debit_minor, fee_minor,
       conversion_principal_minor, destination_net_minor, settlement_token_units,
       fx_rate_numerator, fx_rate_denominator, fixture_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING *`,
    [
      t.id,
      t.ownerId,
      t.quoteId,
      t.status ?? "FUNDING_PENDING",
      t.purpose,
      t.demoScenario,
      jsonParam(t.recipientSnapshot),
      t.sourceCurrency,
      t.destinationCurrency,
      String(t.sourceDebitMinor),
      String(t.feeMinor),
      String(t.conversionPrincipalMinor),
      String(t.destinationNetMinor),
      String(t.settlementTokenUnits),
      String(t.fxRateNumerator),
      String(t.fxRateDenominator),
      t.fixtureVersion,
    ],
  );
  return toRow(rows[0]);
}

/** Owner-scoped read: null for a missing transfer or another owner's transfer. */
export async function getTransferForOwner(
  db: Queryable,
  ownerId: string,
  id: string,
): Promise<TransferRow | null> {
  const { rows } = await db.query("SELECT * FROM transfers WHERE id = $1 AND owner_id = $2", [
    id,
    ownerId,
  ]);
  return rows[0] ? toRow(rows[0]) : null;
}

/** Unscoped read by ID (internal use only: callers must already have checked ownership). */
export async function getTransferById(db: Queryable, id: string): Promise<TransferRow | null> {
  const { rows } = await db.query("SELECT * FROM transfers WHERE id = $1", [id]);
  return rows[0] ? toRow(rows[0]) : null;
}

/** Transfer created from a quote (idempotent replay / QUOTE_ALREADY_ACCEPTED lookups). */
export async function getTransferByQuoteId(
  db: Queryable,
  quoteId: string,
): Promise<TransferRow | null> {
  const { rows } = await db.query("SELECT * FROM transfers WHERE quote_id = $1", [quoteId]);
  return rows[0] ? toRow(rows[0]) : null;
}

/** `SELECT … FOR UPDATE` inside a transaction. */
export async function getTransferForUpdate(
  client: pg.PoolClient,
  id: string,
): Promise<TransferRow | null> {
  const { rows } = await client.query("SELECT * FROM transfers WHERE id = $1 FOR UPDATE", [id]);
  return rows[0] ? toRow(rows[0]) : null;
}

/**
 * Optimistic update: applies `patch`, bumps `version` and `updated_at`, only if
 * the row is still at `expectedVersion` (and, if given, at `expectedEpoch`).
 * Returns the new row, or null if someone else moved it (re-read and return the
 * current snapshot). An empty patch still bumps the version.
 */
export async function updateTransferWithVersion(
  client: Queryable,
  id: string,
  expectedVersion: number,
  patch: TransferPatch,
  opts: { expectedEpoch?: number } = {},
): Promise<TransferRow | null> {
  const sets: string[] = ["version = version + 1", "updated_at = now()"];
  const params: unknown[] = [id, expectedVersion];
  for (const [key, value] of Object.entries(patch) as [keyof TransferPatch, unknown][]) {
    if (value === undefined) continue;
    const spec = PATCH_COLUMNS[key];
    if (!spec) throw new Error(`updateTransferWithVersion: unknown patch field ${String(key)}`);
    params.push(spec.json ? jsonParam(value) : value);
    sets.push(`${spec.column} = $${params.length}`);
  }
  let where = "id = $1 AND version = $2";
  if (opts.expectedEpoch !== undefined) {
    params.push(opts.expectedEpoch);
    where += ` AND claim_epoch = $${params.length}`;
  }
  const { rows } = await client.query(
    `UPDATE transfers SET ${sets.join(", ")} WHERE ${where} RETURNING *`,
    params,
  );
  return rows[0] ? toRow(rows[0]) : null;
}

/**
 * Take the processing claim for `/advance` (plan 4.4). Increments `claim_epoch`
 * and sets a lease of `ttlSeconds`, only if no unexpired claim exists.
 * Returns the new epoch (the caller's fence), or null if another caller holds
 * the claim or the transfer does not exist. Runs as a single autocommit
 * statement; never call it inside a long transaction.
 */
export async function claimTransfer(
  id: string,
  ttlSeconds: number,
  db: Queryable = getPool(),
): Promise<number | null> {
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error("claimTransfer: ttlSeconds must be a positive number");
  }
  const { rows } = await db.query<{ claim_epoch: number }>(
    `UPDATE transfers
        SET claim_epoch = claim_epoch + 1,
            claim_expires_at = now() + make_interval(secs => $2)
      WHERE id = $1 AND (claim_expires_at IS NULL OR claim_expires_at < now())
      RETURNING claim_epoch`,
    [id, ttlSeconds],
  );
  return rows[0] ? rows[0].claim_epoch : null;
}

/**
 * Release a claim held at `epoch` (clears the lease; the epoch stays so stale
 * holders remain fenced out once someone else claims). Returns false if the
 * claim was already taken over by a newer epoch.
 */
export async function releaseTransfer(
  id: string,
  epoch: number,
  db: Queryable = getPool(),
): Promise<boolean> {
  const { rowCount } = await db.query(
    "UPDATE transfers SET claim_expires_at = NULL WHERE id = $1 AND claim_epoch = $2",
    [id, epoch],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Fence check for writers (part 4 calls this inside the transaction that
 * persists a signed attempt). Locks the transfer row `FOR UPDATE` until the
 * caller's transaction ends and throws `StaleFenceError` if the epoch moved.
 * Must be called on a client inside an open transaction.
 */
export async function assertFence(client: pg.PoolClient, fence: Fence): Promise<void> {
  const { rows } = await client.query<{ claim_epoch: number }>(
    "SELECT claim_epoch FROM transfers WHERE id = $1 FOR UPDATE",
    [fence.transferId],
  );
  const row = rows[0];
  if (!row) throw new StaleFenceError(fence.transferId, fence.epoch, null);
  if (row.claim_epoch !== fence.epoch) {
    throw new StaleFenceError(fence.transferId, fence.epoch, row.claim_epoch);
  }
}
