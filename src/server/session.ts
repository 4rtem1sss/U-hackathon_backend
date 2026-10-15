import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import { findActiveSessionByTokenHash, getPool, insertDemoSession, insertRecipient, withTransaction, type Queryable } from "@/db";
import { ApiError } from "@/lib/errors";
import { ID_PREFIX, newId } from "@/lib/ids";

/**
 * Anonymous demo sessions (api-contract section 2).
 *
 * The browser holds a random token in the HttpOnly `demo_session` cookie; the DB
 * stores only its sha256 hex (`demo_sessions.token_hash`). The public `sessionId`
 * is not the secret. `requireSession` resolves the cookie to `{ ownerId, sessionId }`
 * or throws 401 UNAUTHENTICATED; `createOrResumeSession` backs `POST /api/demo/session`.
 */

export const SESSION_COOKIE = "demo_session";

export const SESSION_TTL_SECONDS = 86400;

export interface Session {
  ownerId: string;
  sessionId: string;
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return null;
    }
  }
  return null;
}

export async function requireSession(req: Request, db: Queryable = getPool()): Promise<Session> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token || token.length > 512) throw new ApiError("UNAUTHENTICATED");
  const row = await findActiveSessionByTokenHash(db, hashSessionToken(token));
  if (!row) throw new ApiError("UNAUTHENTICATED");
  return { ownerId: row.ownerId, sessionId: row.id };
}

export interface CreatedSession {
  sessionId: string;
  ownerId: string;
  expiresAt: Date;
}

/**
 * Resume the session named by the request's cookie (`created: false`, no token), or
 * create a new session plus the owner's synthetic recipient in one transaction
 * (`created: true`, with the raw token to set as a cookie).
 */
export async function createOrResumeSession(
  req: Request,
  deps: { pool?: pg.Pool } = {},
): Promise<{ created: boolean; session: CreatedSession; token?: string }> {
  const pool = deps.pool ?? getPool();
  const existing = readCookie(req, SESSION_COOKIE);
  if (existing && existing.length <= 512) {
    const row = await findActiveSessionByTokenHash(pool, hashSessionToken(existing));
    if (row) {
      return { created: false, session: { sessionId: row.id, ownerId: row.ownerId, expiresAt: row.expiresAt } };
    }
  }

  const token = randomBytes(32).toString("base64url");
  const session = await withTransaction(
    async (client) => {
      const row = await insertDemoSession(client, {
        id: newId(ID_PREFIX.session),
        tokenHash: hashSessionToken(token),
        ownerId: newId(ID_PREFIX.owner),
        ttlSeconds: SESSION_TTL_SECONDS,
      });
      await insertRecipient(client, {
        id: newId(ID_PREFIX.recipient),
        ownerId: row.ownerId,
        name: "Demo Recipient",
        bankLabel: "Demo Thai Bank",
        accountDisplay: "TEST ACCOUNT 0001",
      });
      return { sessionId: row.id, ownerId: row.ownerId, expiresAt: row.expiresAt };
    },
    { pool },
  );
  return { created: true, session, token };
}

/** `Set-Cookie` value for the session token (HttpOnly, SameSite=Lax, 24h). */
export function sessionCookieHeader(token: string, expiresAt: Date, secure: boolean): string {
  return (
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}` +
    `; Expires=${expiresAt.toUTCString()}${secure ? "; Secure" : ""}`
  );
}

/** True for an https request URL or an `x-forwarded-proto: https` proxy hop. */
export function isSecureRequest(req: Request): boolean {
  if (new URL(req.url).protocol === "https:") return true;
  return req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase() === "https";
}
