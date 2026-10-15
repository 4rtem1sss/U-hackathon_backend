import "server-only";
import type pg from "pg";
import { mapRow } from "../map";
import type { Queryable } from "../pool";
import type { IdempotencyKeyRow, IdempotencyScope } from "../types";

export type ReserveResult =
  /** This call inserted the key: perform the operation. */
  | { inserted: true; row: IdempotencyKeyRow }
  /** Key already existed (possibly just committed by a concurrent request). */
  | { inserted: false; row: IdempotencyKeyRow; fingerprintMatches: boolean };

/**
 * Reserve `(ownerId, scope, key)` inside the caller's transaction:
 * `INSERT … ON CONFLICT DO NOTHING`, then read the existing row on conflict.
 *
 * Concurrency: a second request with the same key blocks on the INSERT until
 * the first transaction commits (then sees its row) or rolls back (then
 * inserts). Use READ COMMITTED (the default); under REPEATABLE READ or
 * SERIALIZABLE the conflicting insert raises a serialization failure instead.
 *
 * For FUNDING / PAYOUT_RETRY, `transferId` is required and the fingerprint
 * should include it, so a key reused for a different transfer is a conflict.
 */
export async function reserveIdempotencyKey(
  client: pg.PoolClient,
  ownerId: string,
  scope: IdempotencyScope,
  key: string,
  fingerprint: string,
  transferId: string | null = null,
): Promise<ReserveResult> {
  const ins = await client.query(
    `INSERT INTO idempotency_keys (owner_id, scope, key, fingerprint, transfer_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (owner_id, scope, key) DO NOTHING
     RETURNING *`,
    [ownerId, scope, key, fingerprint, transferId],
  );
  if (ins.rows[0]) return { inserted: true, row: mapRow<IdempotencyKeyRow>(ins.rows[0]) };

  const existing = await getIdempotencyKey(client, ownerId, scope, key);
  if (!existing) {
    // Only possible if the row was deleted between the two statements.
    throw new Error("idempotency key vanished after conflict");
  }
  return { inserted: false, row: existing, fingerprintMatches: existing.fingerprint === fingerprint };
}

export async function getIdempotencyKey(
  db: Queryable,
  ownerId: string,
  scope: IdempotencyScope,
  key: string,
): Promise<IdempotencyKeyRow | null> {
  const { rows } = await db.query(
    "SELECT * FROM idempotency_keys WHERE owner_id = $1 AND scope = $2 AND key = $3",
    [ownerId, scope, key],
  );
  return rows[0] ? mapRow<IdempotencyKeyRow>(rows[0]) : null;
}

/**
 * Record the outcome on a key reserved in the same transaction: the transfer it
 * belongs to (for CREATE_TRANSFER, set once the transfer exists) and the HTTP
 * status of the original response.
 */
export async function completeIdempotencyKey(
  client: pg.PoolClient,
  ownerId: string,
  scope: IdempotencyScope,
  key: string,
  result: { transferId: string; responseStatus: number },
): Promise<IdempotencyKeyRow> {
  const { rows } = await client.query(
    `UPDATE idempotency_keys SET transfer_id = $4, response_status = $5
      WHERE owner_id = $1 AND scope = $2 AND key = $3
      RETURNING *`,
    [ownerId, scope, key, result.transferId, result.responseStatus],
  );
  if (!rows[0]) throw new Error("completeIdempotencyKey: key not reserved");
  return mapRow<IdempotencyKeyRow>(rows[0]);
}
