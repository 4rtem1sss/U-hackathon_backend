import "server-only";
import { mapRow } from "../map";
import type { Queryable } from "../pool";
import type { SettlementAttemptRow } from "../types";

/**
 * Read-only access for part 3. Part 4's module is the only writer of
 * settlement_attempts. The returned row contains `signedTx`: never put it in
 * an API response or log.
 */
export async function latestSettlementAttemptForTransfer(
  db: Queryable,
  transferId: string,
): Promise<SettlementAttemptRow | null> {
  const { rows } = await db.query(
    `SELECT * FROM settlement_attempts WHERE transfer_id = $1
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [transferId],
  );
  return rows[0] ? mapRow<SettlementAttemptRow>(rows[0]) : null;
}
