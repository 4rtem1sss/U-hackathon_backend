import { randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll } from "vitest";
import { resetEnvCache } from "@/config/env";
import { closePool } from "@/db/pool";
import type { QuoteRow } from "@/db/types";
import { newId } from "@/lib/ids";
import { hashSessionToken, SESSION_COOKIE } from "@/server/session";
import { createMigratedDb, seedQuote, type TestDb } from "../db/helpers";

export { describeDb } from "../db/helpers";

export const TEST_ORIGIN = "http://localhost:3000";

export interface TestSession {
  ownerId: string;
  sessionId: string;
  token: string;
  cookie: string;
}

/** Insert a demo session row directly (part 2 owns real session creation). */
export async function seedSession(pool: pg.Pool, opts: { expiresInSeconds?: number } = {}): Promise<TestSession> {
  const token = randomBytes(32).toString("base64url");
  const ownerId = newId("own");
  const sessionId = newId("ses");
  await pool.query(
    `INSERT INTO demo_sessions (id, token_hash, owner_id, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(secs => $4))`,
    [sessionId, hashSessionToken(token), ownerId, opts.expiresInSeconds ?? 3600],
  );
  return { ownerId, sessionId, token, cookie: `${SESSION_COOKIE}=${token}` };
}

/** Session + recipient + OPEN quote for that session's owner. */
export async function seedSessionWithQuote(
  pool: pg.Pool,
  opts: { quoteExpiresInSeconds?: number } = {},
): Promise<{ session: TestSession; quote: QuoteRow }> {
  const session = await seedSession(pool);
  const quote = await seedQuote(pool, session.ownerId, { expiresInSeconds: opts.quoteExpiresInSeconds ?? 300 });
  return { session, quote };
}

/**
 * Fresh migrated database for the file, with `process.env` pointed at it so the
 * route handlers' `getPool()` / `getEnv()` use it. Call inside a describe block.
 */
export function useApiTestDb(): { readonly db: TestDb } {
  const holder: { db?: TestDb } = {};
  const saved: Record<string, string | undefined> = {};
  beforeAll(async () => {
    holder.db = await createMigratedDb();
    const vars: Record<string, string> = {
      DATABASE_URL: holder.db.url,
      DESTINATION_SETTLEMENT_ADDRESS: `0x${"1".repeat(40)}`,
      ALLOWED_ORIGINS: TEST_ORIGIN,
    };
    for (const [k, v] of Object.entries(vars)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    resetEnvCache();
    await closePool();
  });
  afterAll(async () => {
    await closePool();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetEnvCache();
    await holder.db?.drop();
  });
  return {
    get db() {
      if (!holder.db) throw new Error("test db not ready");
      return holder.db;
    },
  };
}

export interface ReqOptions {
  method?: string;
  cookie?: string | null;
  idempotencyKey?: string | null;
  /** undefined -> TEST_ORIGIN; null -> no Origin header. */
  origin?: string | null;
  body?: unknown;
  rawBody?: string;
}

export function apiRequest(path: string, opts: ReqOptions = {}): Request {
  const headers = new Headers();
  if (opts.cookie) headers.set("cookie", opts.cookie);
  if (opts.idempotencyKey) headers.set("idempotency-key", opts.idempotencyKey);
  const method = opts.method ?? "POST";
  const origin = opts.origin === undefined ? TEST_ORIGIN : opts.origin;
  if (origin) headers.set("origin", origin);
  let body: string | undefined;
  if (method !== "GET") {
    headers.set("content-type", "application/json");
    body = opts.rawBody ?? JSON.stringify(opts.body ?? {});
  }
  return new Request(`${TEST_ORIGIN}${path}`, { method, headers, ...(body === undefined ? {} : { body }) });
}

export const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });

export const newKey = (): string => randomUUID();

export interface Envelope {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any;
  error?: { code: string; message: string; retryable: boolean; fieldErrors: Record<string, string> };
  meta: { requestId: string; apiVersion: string; replayed?: boolean };
}

export async function readJson(res: Response): Promise<Envelope> {
  return (await res.json()) as Envelope;
}
