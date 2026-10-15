import "server-only";
import { createHash } from "node:crypto";
import type pg from "pg";
import { completeIdempotencyKey, reserveIdempotencyKey, type IdempotencyScope } from "@/db";
import { ApiError } from "@/lib/errors";

/**
 * Idempotency helpers (api-contract section 5 table).
 *
 * Keys are reserved per (ownerId, scope, key) — the table's primary key — so a
 * key can only ever replay the caller's own operation: authorization happens
 * before any replay by construction. Keep that property.
 */

export const IDEMPOTENCY_HEADER = "idempotency-key";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The `Idempotency-Key` header as a lower-cased UUID, else 400 IDEMPOTENCY_KEY_REQUIRED. */
export function requireIdempotencyKey(req: Request): string {
  const value = req.headers.get(IDEMPOTENCY_HEADER)?.trim();
  if (!value || !UUID_RE.test(value)) {
    throw new ApiError("IDEMPOTENCY_KEY_REQUIRED", {
      message: "An Idempotency-Key header containing a UUID is required for this request.",
    });
  }
  return value.toLowerCase();
}

/** Deterministic JSON with object keys sorted recursively. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "bigint") return JSON.stringify(value.toString());
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/**
 * sha256 (hex) of the canonical JSON of the semantic request fields. For
 * FUNDING / PAYOUT_RETRY pass the transferId so a key reused on another
 * transfer is a conflict.
 */
export function fingerprint(scope: IdempotencyScope, fields: Record<string, unknown>, transferId?: string): string {
  const payload = transferId === undefined ? { scope, fields } : { scope, transferId, fields };
  return createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
}

export type ReserveOutcome =
  | { kind: "new" }
  | { kind: "replay"; transferId: string; responseStatus: number | null };

export interface ReserveKeyInput {
  ownerId: string;
  scope: IdempotencyScope;
  key: string;
  fingerprint: string;
  /** Required for FUNDING / PAYOUT_RETRY; null for CREATE_TRANSFER. */
  transferId?: string | null;
}

/**
 * Reserve the key inside the caller's READ COMMITTED transaction.
 * - `new`: this request owns the key; do the work, then `completeKey` in the same tx.
 * - `replay`: same owner/key/payload already completed; return the current snapshot.
 * - different payload: throws 409 IDEMPOTENCY_CONFLICT.
 *
 * A concurrent same-key request blocks on the insert until the first transaction
 * commits (then replays) or rolls back (then becomes `new`).
 */
export async function reserveKey(client: pg.PoolClient, input: ReserveKeyInput): Promise<ReserveOutcome> {
  const r = await reserveIdempotencyKey(
    client,
    input.ownerId,
    input.scope,
    input.key,
    input.fingerprint,
    input.transferId ?? null,
  );
  if (r.inserted) return { kind: "new" };
  if (!r.fingerprintMatches) throw new ApiError("IDEMPOTENCY_CONFLICT");
  if (r.row.transferId === null) {
    // Reservation and completion share one transaction, so a committed key always
    // has its transfer. Reaching this means the invariant was broken.
    throw new Error("idempotency key committed without a transfer");
  }
  return { kind: "replay", transferId: r.row.transferId, responseStatus: r.row.responseStatus };
}

export function completeKey(
  client: pg.PoolClient,
  input: { ownerId: string; scope: IdempotencyScope; key: string; transferId: string; responseStatus: number },
): Promise<unknown> {
  return completeIdempotencyKey(client, input.ownerId, input.scope, input.key, {
    transferId: input.transferId,
    responseStatus: input.responseStatus,
  });
}
