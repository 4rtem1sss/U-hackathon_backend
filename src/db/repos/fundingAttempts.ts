import "server-only";
import type pg from "pg";
import { mapRow } from "../map";
import type { Queryable } from "../pool";
import type { FundingAttemptRow, FundingAttemptStatus } from "../types";

export interface NewFundingAttempt {
  id: string;
  transferId: string;
  requestId: string;
  status: FundingAttemptStatus;
  reference: string;
}

/** Insert the (single) funding attempt. unique(transfer_id) rejects a second one. */
export async function insertFundingAttempt(
  client: pg.PoolClient,
  a: NewFundingAttempt,
): Promise<FundingAttemptRow> {
  const { rows } = await client.query(
    `INSERT INTO funding_attempts (id, transfer_id, request_id, status, reference)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [a.id, a.transferId, a.requestId, a.status, a.reference],
  );
  return mapRow<FundingAttemptRow>(rows[0]);
}

export async function getFundingAttemptForTransfer(
  db: Queryable,
  transferId: string,
): Promise<FundingAttemptRow | null> {
  const { rows } = await db.query("SELECT * FROM funding_attempts WHERE transfer_id = $1", [
    transferId,
  ]);
  return rows[0] ? mapRow<FundingAttemptRow>(rows[0]) : null;
}
