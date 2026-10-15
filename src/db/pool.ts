import "server-only";
import pg from "pg";
import { getEnv } from "@/config/env";

/** Anything that can run a query: the pool itself or a checked-out client. */
export type Queryable = pg.Pool | pg.PoolClient;

const INT8_OID = 20;
const NUMERIC_OID = 1700;

/**
 * Type parsers for our pools: keep `numeric` and `int8` (bigint) as strings so
 * amounts and nonces never pass through a JS float. (These are pg's defaults
 * already; we pin them so a global `pg.types.setTypeParser` elsewhere cannot
 * change them for us.)
 */
const typeOverrides: pg.CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: "text" | "binary") => {
    if (oid === INT8_OID || oid === NUMERIC_OID) return (value: string) => value;
    return pg.types.getTypeParser(oid, format ?? "text");
  }) as pg.CustomTypesConfig["getTypeParser"],
};

/** Create a new pool (tests and scripts). App code should use `getPool()`. */
export function createPool(connectionString: string, config: pg.PoolConfig = {}): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    ...config,
    types: typeOverrides,
  });
  // An idle client error (e.g. server restart) must not crash the process.
  pool.on("error", () => {});
  return pool;
}

let pool: pg.Pool | undefined;

/** Lazily created, process-wide pool from `DATABASE_URL`. Server-only. */
export function getPool(): pg.Pool {
  if (!pool) pool = createPool(getEnv().DATABASE_URL);
  return pool;
}

/** Close the shared pool (tests / graceful shutdown). */
export async function closePool(): Promise<void> {
  const p = pool;
  pool = undefined;
  if (p) await p.end();
}
