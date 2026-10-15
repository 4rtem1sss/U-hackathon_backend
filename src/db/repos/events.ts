import "server-only";
import type pg from "pg";
import { mapRow } from "../map";
import type { Queryable } from "../pool";
import type { TransferEventRow, TransferStatus } from "../types";

export interface NewTransferEvent {
  transferId: string;
  fromStatus: TransferStatus | null;
  toStatus: TransferStatus;
  reason?: string | null;
  /** Funding/settlement/payout attempt ID that caused the transition, if any. */
  attemptRef?: string | null;
}

/**
 * Append an event with the next per-transfer sequence (max + 1), computed inside
 * the caller's transaction. The caller must hold the transfer row lock (it does
 * after `insertTransfer`, `getTransferForUpdate`, `updateTransferWithVersion` or
 * `assertFence` in the same transaction); otherwise two concurrent appends can
 * collide on unique(transfer_id, sequence) and one transaction fails.
 */
export async function appendTransferEvent(
  client: pg.PoolClient,
  e: NewTransferEvent,
): Promise<TransferEventRow> {
  const { rows } = await client.query(
    `INSERT INTO transfer_events (transfer_id, sequence, from_status, to_status, reason, attempt_ref)
     SELECT $1, COALESCE(MAX(sequence), 0) + 1, $2, $3, $4, $5
       FROM transfer_events WHERE transfer_id = $1
     RETURNING *`,
    [e.transferId, e.fromStatus, e.toStatus, e.reason ?? null, e.attemptRef ?? null],
  );
  return mapRow<TransferEventRow>(rows[0]);
}

/** All events of a transfer in sequence order. */
export async function listTransferEvents(
  db: Queryable,
  transferId: string,
): Promise<TransferEventRow[]> {
  const { rows } = await db.query(
    "SELECT * FROM transfer_events WHERE transfer_id = $1 ORDER BY sequence",
    [transferId],
  );
  return rows.map((r) => mapRow<TransferEventRow>(r));
}
