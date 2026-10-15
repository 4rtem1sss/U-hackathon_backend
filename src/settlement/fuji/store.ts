import "server-only";
import type pg from "pg";
import { getPool, type Queryable } from "@/db/pool";
import { withTransaction } from "@/db/tx";
import type { SettlementAttemptRow } from "@/db/types";
import { mapRow } from "@/db/map";
import type {
  FujiAttemptRecord,
  FujiAttemptStore,
  FujiAttemptUpdate,
  NewFujiAttempt,
} from "./types";

function toRecord(row: SettlementAttemptRow): FujiAttemptRecord {
  if (!row.signedTx || !row.txHash) {
    throw new Error("Fuji settlement attempt is missing persisted signed transaction metadata.");
  }
  return {
    attemptId: row.id,
    transferId: row.transferId,
    chainId: row.chainId,
    tokenAddress: row.tokenAddress,
    signer: row.signer,
    destination: row.destination,
    units: row.units,
    nonce: row.nonce,
    signedTx: row.signedTx as `0x${string}`,
    txHash: row.txHash as `0x${string}`,
    phase: row.phase,
    receiptBlockNumber: row.receiptBlockNumber,
    receiptBlockHash: row.receiptBlockHash,
    storedOutcome: row.evidence,
    createdFence: row.createdFence,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
async function latest(db: Queryable, transferId: string): Promise<FujiAttemptRecord | null> {
  const { rows } = await db.query(
    `SELECT * FROM settlement_attempts
      WHERE transfer_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [transferId],
  );
  return rows[0] ? toRecord(mapRow<SettlementAttemptRow>(rows[0])) : null;
}

/** PostgreSQL implementation. Every mutation is issued through a caller-owned transaction. */
export class PgFujiAttemptStore implements FujiAttemptStore<pg.PoolClient> {
  constructor(private readonly pool: () => pg.Pool = getPool) {}

  transaction<T>(fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
    return withTransaction(fn, { isolationLevel: "READ COMMITTED", pool: this.pool() });
  }

  latest(transferId: string, tx?: pg.PoolClient): Promise<FujiAttemptRecord | null> {
    return latest(tx ?? this.pool(), transferId);
  }

  async unresolvedForSigner(signer: string, tx: pg.PoolClient): Promise<FujiAttemptRecord | null> {
    const { rows } = await tx.query(
      `SELECT * FROM settlement_attempts
        WHERE chain_id = 43113
          AND lower(signer) = lower($1)
          AND phase IN ('PREPARED', 'BROADCAST', 'PENDING')
        ORDER BY created_at ASC, id ASC
        LIMIT 1`,
      [signer],
    );
    return rows[0] ? toRecord(mapRow<SettlementAttemptRow>(rows[0])) : null;
  }

  async insert(tx: pg.PoolClient, attempt: NewFujiAttempt): Promise<FujiAttemptRecord> {
    const { rows } = await tx.query(
      `INSERT INTO settlement_attempts (
         id, transfer_id, chain_id, token_address, signer, destination, units,
         nonce, signed_tx, tx_hash, phase, created_fence
       ) VALUES ($1, $2, $3, lower($4), lower($5), lower($6), $7, $8, $9, lower($10), 'PREPARED', $11)
       RETURNING *`,
      [
        attempt.attemptId,
        attempt.intent.transferId,
        attempt.intent.chainId,
        attempt.intent.tokenAddress,
        attempt.signer,
        attempt.intent.destination,
        attempt.intent.units,
        attempt.nonce,
        attempt.signedTx,
        attempt.txHash,
        attempt.createdFence,
      ],
    );
    return toRecord(mapRow<SettlementAttemptRow>(rows[0]));
  }

  async update(tx: pg.PoolClient, update: FujiAttemptUpdate): Promise<FujiAttemptRecord | null> {
    const { rows } = await tx.query(
      `UPDATE settlement_attempts
          SET phase = $2,
              receipt_block_number = COALESCE($3, receipt_block_number),
              receipt_block_hash = COALESCE($4, receipt_block_hash),
              evidence = COALESCE($5::jsonb, evidence),
              updated_at = now()
        WHERE id = $1 AND phase = ANY($6::text[])
        RETURNING *`,
      [
        update.attemptId,
        update.phase,
        update.receiptBlockNumber ?? null,
        update.receiptBlockHash ?? null,
        update.storedOutcome === undefined ? null : JSON.stringify(update.storedOutcome),
        update.expectedPhases,
      ],
    );
    return rows[0] ? toRecord(mapRow<SettlementAttemptRow>(rows[0])) : null;
  }
}
