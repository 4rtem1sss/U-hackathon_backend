import { randomUUID } from "node:crypto";

/** Known ID prefixes. IDs are opaque to clients; the prefix is only a debugging aid. */
export const ID_PREFIX = {
  request: "req",
  session: "ses",
  recipient: "rcp",
  quote: "qt",
  transfer: "tr",
  transferEvent: "evt",
  funding: "fnd",
  settlementAttempt: "stl",
  payout: "pay",
  receipt: "rct",
} as const;

export type IdPrefix = (typeof ID_PREFIX)[keyof typeof ID_PREFIX];

const PREFIX_RE = /^[a-z][a-z0-9]{0,15}$/;
const UUID_RE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** `newId("tr")` -> `tr_3f2b…` (prefix + "_" + random UUID v4). */
export function newId(prefix: string): string {
  if (!PREFIX_RE.test(prefix)) {
    throw new Error(`invalid id prefix: ${JSON.stringify(prefix)}`);
  }
  return `${prefix}_${randomUUID()}`;
}

/** True if `value` looks like an ID minted by `newId(prefix)`. */
export function isId(value: unknown, prefix: string): value is string {
  return typeof value === "string" && new RegExp(`^${prefix}_${UUID_RE}$`).test(value);
}

export function newRequestId(): string {
  return newId(ID_PREFIX.request);
}
