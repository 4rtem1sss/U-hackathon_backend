import { createHash, timingSafeEqual } from "node:crypto";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Constant-time check of `Authorization: Bearer <secret>` for the internal
 * settlement route. Both sides are hashed first so the comparison never
 * leaks the secret's length.
 */
export function isInternalRpcAuthorized(header: string | null, secret: string): boolean {
  const match = /^Bearer (.+)$/.exec(header ?? "");
  const presented = match?.[1] ?? "";
  const equal = timingSafeEqual(digest(presented), digest(secret));
  return equal && presented.length > 0 && secret.length > 0;
}
