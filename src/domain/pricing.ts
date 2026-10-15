/**
 * Versioned fixture pricing policy (pure BigInt math; safe to import from the browser).
 * Never use Number/parseInt/float on amounts here.
 */
export interface FixturePolicy {
  version: string;
  minDebitMinor: bigint;
  maxDebitMinor: bigint;
  feeBasisPoints: bigint;
  fxRateNumerator: bigint;
  fxRateDenominator: bigint;
  usdDecimals: bigint;
  thbDecimals: bigint;
  usdcDecimals: bigint;
}

// Illustrative demo fixture (api-contract v1 section 3), not a live rate or business price.
export const FIXTURE_US_TH_V1: FixturePolicy = {
  version: "fixture-us-th-v1",
  minDebitMinor: 100n,
  maxDebitMinor: 10000n,
  feeBasisPoints: 200n,
  fxRateNumerator: 35n,
  fxRateDenominator: 1n,
  usdDecimals: 2n,
  thbDecimals: 2n,
  usdcDecimals: 6n,
};

export function assertValidPolicy(policy: FixturePolicy): void {
  if (policy.minDebitMinor <= 0n) throw new RangeError("minDebitMinor must be > 0");
  if (policy.maxDebitMinor < policy.minDebitMinor) {
    throw new RangeError("maxDebitMinor must be >= minDebitMinor");
  }
  if (policy.feeBasisPoints < 0n || policy.feeBasisPoints >= 10000n) {
    throw new RangeError("feeBasisPoints must be in [0, 10000)");
  }
  if (policy.fxRateNumerator <= 0n) throw new RangeError("fxRateNumerator must be > 0");
  if (policy.fxRateDenominator <= 0n) throw new RangeError("fxRateDenominator must be > 0");
  if (policy.usdDecimals < 0n) throw new RangeError("usdDecimals must be >= 0");
  if (policy.thbDecimals < 0n) throw new RangeError("thbDecimals must be >= 0");
  if (policy.usdcDecimals < policy.usdDecimals) {
    throw new RangeError("usdcDecimals must be >= usdDecimals");
  }
}

export type DebitParseResult =
  | { ok: true; value: bigint }
  | { ok: false; error: "MALFORMED" | "OUT_OF_RANGE" };

const CANONICAL_UINT = /^(0|[1-9][0-9]*)$/;

export function parseSourceDebitMinor(input: unknown, policy: FixturePolicy): DebitParseResult {
  assertValidPolicy(policy);
  if (typeof input !== "string" || !CANONICAL_UINT.test(input)) {
    return { ok: false, error: "MALFORMED" };
  }
  // Never BigInt() an unbounded string.
  if (input.length > policy.maxDebitMinor.toString().length) {
    return { ok: false, error: "OUT_OF_RANGE" };
  }
  const value = BigInt(input);
  if (value < policy.minDebitMinor || value > policy.maxDebitMinor) {
    return { ok: false, error: "OUT_OF_RANGE" };
  }
  return { ok: true, value };
}

export interface PricedAmounts {
  sourceDebitMinor: bigint;
  feeMinor: bigint;
  conversionPrincipalMinor: bigint;
  destinationNetMinor: bigint;
  settlementTokenUnits: bigint;
}

export function computeAmounts(sourceDebitMinor: bigint, policy: FixturePolicy): PricedAmounts {
  assertValidPolicy(policy);
  if (sourceDebitMinor < policy.minDebitMinor || sourceDebitMinor > policy.maxDebitMinor) {
    throw new RangeError("sourceDebitMinor is outside the policy range");
  }
  // Fee rounds up (never undercharge); THB floors (never overpay).
  const feeMinor = (sourceDebitMinor * policy.feeBasisPoints + 9999n) / 10000n;
  const conversionPrincipalMinor = sourceDebitMinor - feeMinor;
  const destinationNetMinor =
    (conversionPrincipalMinor * policy.fxRateNumerator * 10n ** policy.thbDecimals) /
    (policy.fxRateDenominator * 10n ** policy.usdDecimals);
  const settlementTokenUnits =
    conversionPrincipalMinor * 10n ** (policy.usdcDecimals - policy.usdDecimals);
  return { sourceDebitMinor, feeMinor, conversionPrincipalMinor, destinationNetMinor, settlementTokenUnits };
}
