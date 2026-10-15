import "server-only";
import { mapRow } from "../map";
import type { Queryable } from "../pool";
import type { DemoSessionRow } from "../types";

export interface NewDemoSession {
  id: string;
  tokenHash: string;
  ownerId: string;
  ttlSeconds: number;
}

/** Insert a session; `expires_at` is computed from the DB clock. */
export async function insertDemoSession(db: Queryable, s: NewDemoSession): Promise<DemoSessionRow> {
  const { rows } = await db.query(
    `INSERT INTO demo_sessions (id, token_hash, owner_id, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(secs => $4))
     RETURNING *`,
    [s.id, s.tokenHash, s.ownerId, s.ttlSeconds],
  );
  return mapRow<DemoSessionRow>(rows[0]);
}

/** The session for a token hash, or null if unknown or expired (DB clock). */
export async function findActiveSessionByTokenHash(
  db: Queryable,
  tokenHash: string,
): Promise<DemoSessionRow | null> {
  const { rows } = await db.query(
    "SELECT * FROM demo_sessions WHERE token_hash = $1 AND expires_at > now()",
    [tokenHash],
  );
  return rows[0] ? mapRow<DemoSessionRow>(rows[0]) : null;
}
