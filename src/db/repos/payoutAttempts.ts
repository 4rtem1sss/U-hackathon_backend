import "server-only";
import type pg from "pg";
import { mapRow } from "../map";
import type { Queryable } from "../pool";
import type { PayoutAttemptRow, PayoutAttemptStatus } from "../types";

export interface NewPayoutAttempt {
  id: string;
  transferId: string;
  /** Stable request ID sent to the payout simulator; reused to query UNKNOWN outcomes. */
  requestId: string;
}

/**
 * Insert the next payout attempt (attempt_no = max + 1, status PENDING).
 * Hold the transfer row lock in the same transaction (as for events);
 * unique(transfer_id, attempt_no) rejects a concurrent duplicate.
 */
export async function insertPayoutAttempt(
  client: pg.PoolClient,
  a: NewPayoutAttempt,
): Promise<PayoutAttemptRow> {
  const { rows } = await client.query(
    `INSERT INTO payout_attempts (id, transfer_id, request_id, attempt_no)
     SELECT $1, $2, $3, COALESCE(MAX(attempt_no), 0) + 1
       FROM payout_attempts WHERE transfer_id = $2
     RETURNING *`,
    [a.id, a.transferId, a.requestId],
  );
  return mapRow<PayoutAttemptRow>(rows[0]);
}

/** Latest (highest attempt_no) payout attempt for a transfer. */
export async function getLatestPayoutAttempt(
  db: Queryable,
  transferId: string,
): Promise<PayoutAttemptRow | null> {
  const { rows } = await db.query(
    "SELECT * FROM payout_attempts WHERE transfer_id = $1 ORDER BY attempt_no DESC LIMIT 1",
    [transferId],
  );
  return rows[0] ? mapRow<PayoutAttemptRow>(rows[0]) : null;
}

export async function listPayoutAttempts(
  db: Queryable,
  transferId: string,
): Promise<PayoutAttemptRow[]> {
  const { rows } = await db.query(
    "SELECT * FROM payout_attempts WHERE transfer_id = $1 ORDER BY attempt_no",
    [transferId],
  );
  return rows.map((r) => mapRow<PayoutAttemptRow>(r));
}

/** Record a simulator outcome. Returns null if the attempt does not exist. */
export async function updatePayoutAttemptStatus(
  db: Queryable,
  id: string,
  status: PayoutAttemptStatus,
  reference: string | null = null,
): Promise<PayoutAttemptRow | null> {
  const { rows } = await db.query(
    `UPDATE payout_attempts
        SET status = $2, reference = COALESCE($3, reference), updated_at = now()
      WHERE id = $1 RETURNING *`,
    [id, status, reference],
  );
  return rows[0] ? mapRow<PayoutAttemptRow>(rows[0]) : null;
}
