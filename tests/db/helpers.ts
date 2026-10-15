import { randomBytes } from "node:crypto";
import pg from "pg";
import { describe } from "vitest";
import { createPool } from "@/db/pool";
import { insertQuote } from "@/db/repos/quotes";
import { insertTransfer } from "@/db/repos/transfers";
import type { QuoteRow, TransferRow } from "@/db/types";
import { newId } from "@/lib/ids";
import { runMigrations } from "../../scripts/migrate.mjs";

/**
 * DB tests run only when DATABASE_URL is set AND points at a throwaway server
 * (localhost, or APP_MODE=test as in CI), so a developer's Supabase URL in the
 * environment is never touched. Each test file creates and drops its own
 * database on that server.
 */
const url = process.env.DATABASE_URL;
function isSafeTarget(u: string | undefined): u is string {
  if (!u) return false;
  if (process.env.APP_MODE === "test") return true;
  try {
    const host = new URL(u).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

export const dbEnabled = isSafeTarget(url);
export const describeDb = describe.skipIf(!dbEnabled);

function urlForDb(base: string, dbName: string): string {
  const u = new URL(base);
  u.pathname = `/${dbName}`;
  return u.toString();
}

export interface TestDb {
  url: string;
  pool: pg.Pool;
  drop(): Promise<void>;
}

/** Create an empty database (no migrations applied). */
export async function createEmptyDb(): Promise<{ url: string; drop(): Promise<void> }> {
  const base = url as string;
  const name = `p2p_t_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  return {
    url: urlForDb(base, name),
    async drop() {
      const c = new pg.Client({ connectionString: base });
      await c.connect();
      try {
        await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await c.end();
      }
    },
  };
}

/** Fresh database with all migrations applied, plus a pool on it. */
export async function createMigratedDb(): Promise<TestDb> {
  const empty = await createEmptyDb();
  await runMigrations({ connectionString: empty.url });
  const pool = createPool(empty.url, { max: 20 });
  return {
    url: empty.url,
    pool,
    async drop() {
      await pool.end();
      await empty.drop();
    },
  };
}

/** Insert a recipient + OPEN quote for `ownerId` (5 minute expiry by default). */
export async function seedQuote(
  pool: pg.Pool,
  ownerId: string,
  opts: { expiresInSeconds?: number } = {},
): Promise<QuoteRow> {
  const recipientId = newId("rcp");
  await pool.query(
    `INSERT INTO recipients (id, owner_id, name, bank_label, account_display)
     VALUES ($1, $2, 'Demo Recipient', 'Demo Thai Bank', 'TEST ACCOUNT 0001')`,
    [recipientId, ownerId],
  );
  return insertQuote(pool, {
    id: newId("qt"),
    ownerId,
    recipientId,
    recipientSnapshot: {
      id: recipientId,
      name: "Demo Recipient",
      bankLabel: "Demo Thai Bank",
      accountDisplay: "TEST ACCOUNT 0001",
      isSynthetic: true,
    },
    sourceCountry: "US",
    destinationCountry: "TH",
    sourceCurrency: "USD",
    destinationCurrency: "THB",
    sourceDebitMinor: 1000n,
    feeMinor: "20",
    conversionPrincipalMinor: "980",
    fxRateNumerator: "35",
    fxRateDenominator: "1",
    destinationNetMinor: "34300",
    settlementTokenUnits: "9800000",
    fixtureVersion: "fixture-us-th-v1",
    chainId: 43113,
    expiresAt: new Date(Date.now() + (opts.expiresInSeconds ?? 300) * 1000),
  });
}

/** Insert a FUNDING_PENDING transfer for `quote`. */
export function seedTransfer(pool: pg.Pool | pg.PoolClient, quote: QuoteRow): Promise<TransferRow> {
  return insertTransfer(pool, {
    id: newId("tr"),
    ownerId: quote.ownerId,
    quoteId: quote.id,
    purpose: "PERSONAL_REMITTANCE",
    demoScenario: "HAPPY_PATH",
    recipientSnapshot: quote.recipientSnapshot,
    sourceCurrency: quote.sourceCurrency,
    destinationCurrency: quote.destinationCurrency,
    sourceDebitMinor: quote.sourceDebitMinor,
    feeMinor: quote.feeMinor,
    conversionPrincipalMinor: quote.conversionPrincipalMinor,
    destinationNetMinor: quote.destinationNetMinor,
    settlementTokenUnits: quote.settlementTokenUnits,
    fxRateNumerator: quote.fxRateNumerator,
    fxRateDenominator: quote.fxRateDenominator,
    fixtureVersion: quote.fixtureVersion,
  });
}

export const newOwner = () => newId("ses");
