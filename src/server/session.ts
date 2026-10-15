import "server-only";
import { createHash } from "node:crypto";
import { getPool, type Queryable } from "@/db";
import { ApiError } from "@/lib/errors";

/**
 * TEMPORARY stub until part 2 delivers sessions; keep this signature.
 *
 * Reads the `demo_session` cookie, hashes it (sha256, hex) and looks up an
 * unexpired row in `demo_sessions`. Anything else is 401 UNAUTHENTICATED.
 * Part 2 replaces the body (session creation, rotation, rate limits); callers
 * only rely on `requireSession(req): Promise<{ ownerId, sessionId }>`.
 */

export const SESSION_COOKIE = "demo_session";

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
  const { rows } = await db.query<{ id: string; owner_id: string }>(
    "SELECT id, owner_id FROM demo_sessions WHERE token_hash = $1 AND expires_at > now()",
    [hashSessionToken(token)],
  );
  const row = rows[0];
  if (!row) throw new ApiError("UNAUTHENTICATED");
  return { ownerId: row.owner_id, sessionId: row.id };
}
