import "server-only";
import type pg from "pg";
import { getPool } from "./pool";

export type IsolationLevel = "READ COMMITTED" | "REPEATABLE READ" | "SERIALIZABLE";

export interface TransactionOptions {
  /** Default: the server default (READ COMMITTED). */
  isolationLevel?: IsolationLevel;
  /** Default: `getPool()`. */
  pool?: pg.Pool;
}

const LEVELS: ReadonlySet<string> = new Set(["READ COMMITTED", "REPEATABLE READ", "SERIALIZABLE"]);

/**
 * Run `fn` inside BEGIN/COMMIT on one pooled client; ROLLBACK and rethrow if it
 * throws. Never keep a transaction open across an external RPC call.
 */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
  opts: TransactionOptions = {},
): Promise<T> {
  const level = opts.isolationLevel;
  if (level !== undefined && !LEVELS.has(level)) {
    throw new Error(`invalid isolation level: ${String(level)}`);
  }
  const client = await (opts.pool ?? getPool()).connect();
  let broken = false;
  try {
    await client.query(level ? `BEGIN ISOLATION LEVEL ${level}` : "BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      broken = true; // connection is unusable; destroy it instead of returning it to the pool
    }
    throw err;
  } finally {
    client.release(broken);
  }
}
