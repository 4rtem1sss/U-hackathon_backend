import "server-only";
import type pg from "pg";
import { getPool } from "@/db/pool";
import { assertFence as dbAssertFence } from "@/db/repos/transfers";
import { isStaleFenceError as isDbStaleFenceError } from "@/db/errors";
import { StaleFenceError, type Fence, type FenceGuard } from "./contract";

/**
 * Postgres-backed FenceGuard (plan §4.4). Locks the transfer row and checks
 * `claim_epoch`. Pass the caller's transaction client as `tx` so the lock is
 * held until that transaction commits; without one, the check runs in its own
 * short transaction (useful only as a pre-check).
 */
export const dbFenceGuard: FenceGuard<pg.PoolClient> = {
  async assertFence(fence: Fence, tx?: pg.PoolClient): Promise<void> {
    const run = async (client: pg.PoolClient) => {
      try {
        await dbAssertFence(client, fence);
      } catch (err) {
        if (isDbStaleFenceError(err)) throw new StaleFenceError(fence, err.actualEpoch);
        throw err;
      }
    };
    if (tx) return run(tx);
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await run(client);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  },
};
