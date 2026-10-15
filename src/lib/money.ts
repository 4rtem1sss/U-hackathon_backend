import { z } from "zod";

/**
 * Money and token amounts travel as unsigned base-10 integer strings in minor/base
 * units (USD cents, THB satang, USDC 6-decimal units). Never use floats for money.
 *
 * Accepted: "0", "1", "1000". Rejected: "", "-1", "+1", "1.0", "1e3", "01", " 1",
 * "0x10", "1_000", numbers (non-strings), and anything longer than MAX_DIGITS.
 */

/** numeric(38,0) in Postgres holds up to 38 digits. */
export const MAX_DIGITS = 38;

const UNSIGNED_INT_RE = /^(0|[1-9][0-9]*)$/;

export function isUnsignedIntegerString(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_DIGITS && UNSIGNED_INT_RE.test(value);
}

export class InvalidAmountError extends Error {
  constructor(message = "must be an unsigned integer string without leading zeros") {
    super(message);
    this.name = "InvalidAmountError";
  }
}

/** Strictly parse an amount string into a bigint. Throws `InvalidAmountError`. */
export function parseAmount(value: unknown): bigint {
  if (!isUnsignedIntegerString(value)) throw new InvalidAmountError();
  return BigInt(value);
}

/** Format a non-negative bigint as an amount string. Throws on negative / too large. */
export function formatAmount(value: bigint): string {
  if (typeof value !== "bigint") throw new InvalidAmountError("amount must be a bigint");
  if (value < 0n) throw new InvalidAmountError("amount must not be negative");
  const s = value.toString(10);
  if (s.length > MAX_DIGITS) throw new InvalidAmountError(`amount exceeds ${MAX_DIGITS} digits`);
  return s;
}

/** zod schema for an amount string field in a request body. */
export const amountString = z.string().refine(isUnsignedIntegerString, {
  message: "must be an unsigned integer string without sign, decimal point, exponent or leading zeros",
});
