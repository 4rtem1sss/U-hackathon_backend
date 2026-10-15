import { describe, expect, it } from "vitest";
import {
  FIXTURE_US_TH_V1,
  assertValidPolicy,
  computeAmounts,
  parseSourceDebitMinor,
  type FixturePolicy,
} from "@/domain/pricing";

describe("computeAmounts", () => {
  it.each([
    [1000n, 20n, 980n, 34300n, 9800000n],
    [100n, 2n, 98n, 3430n, 980000n],
    [10000n, 200n, 9800n, 343000n, 98000000n],
  ])("prices %s", (debit, fee, principal, thb, units) => {
    expect(computeAmounts(debit, FIXTURE_US_TH_V1)).toEqual({
      sourceDebitMinor: debit,
      feeMinor: fee,
      conversionPrincipalMinor: principal,
      destinationNetMinor: thb,
      settlementTokenUnits: units,
    });
  });

  it.each([
    [101n, 3n, 98n],
    [149n, 3n, 146n],
    [150n, 3n, 147n],
    [151n, 4n, 147n],
  ])("rounds the fee up for %s", (debit, fee, principal) => {
    const out = computeAmounts(debit, FIXTURE_US_TH_V1);
    expect(out.feeMinor).toBe(fee);
    expect(out.conversionPrincipalMinor).toBe(principal);
  });

  it("floors THB with a non-integer rate", () => {
    const policy: FixturePolicy = { ...FIXTURE_US_TH_V1, fxRateNumerator: 3533n, fxRateDenominator: 100n };
    const out = computeAmounts(1000n, policy);
    expect(out.conversionPrincipalMinor).toBe(980n);
    expect(out.destinationNetMinor).toBe(34623n);
  });

  it("keeps fee invariants for every debit in range", () => {
    for (let debit = 100n; debit <= 10000n; debit++) {
      const { feeMinor, conversionPrincipalMinor } = computeAmounts(debit, FIXTURE_US_TH_V1);
      expect(feeMinor + conversionPrincipalMinor).toBe(debit);
      expect(feeMinor >= 0n).toBe(true);
      expect(feeMinor * 10000n >= debit * 200n).toBe(true);
      expect((feeMinor - 1n) * 10000n < debit * 200n).toBe(true);
    }
  });

  it.each([-1000n, 99n, 10001n])("throws RangeError for out-of-range debit %s", (debit) => {
    expect(() => computeAmounts(debit, FIXTURE_US_TH_V1)).toThrow(RangeError);
  });

  it("throws RangeError for an invalid policy", () => {
    expect(() => computeAmounts(1000n, { ...FIXTURE_US_TH_V1, fxRateDenominator: 0n })).toThrow(RangeError);
  });
});

describe("parseSourceDebitMinor", () => {
  it.each([
    ["100", 100n],
    ["1000", 1000n],
    ["10000", 10000n],
  ])("accepts %s", (input, value) => {
    expect(parseSourceDebitMinor(input, FIXTURE_US_TH_V1)).toEqual({ ok: true, value });
  });

  it.each([
    "",
    " 100",
    "100 ",
    "+100",
    "-100",
    "10.00",
    "1e3",
    "0100",
    "00",
    "abc",
    "١٠٠",
    1000,
    1000n,
    null,
    undefined,
    {},
  ])("rejects malformed input #%# as MALFORMED", (input) => {
    expect(parseSourceDebitMinor(input, FIXTURE_US_TH_V1)).toEqual({ ok: false, error: "MALFORMED" });
  });

  it.each(["0", "99", "10001", "99999999999999999999999", "9".repeat(1_000_000)])(
    "rejects input of length %#  as OUT_OF_RANGE",
    (input) => {
      expect(parseSourceDebitMinor(input, FIXTURE_US_TH_V1)).toEqual({ ok: false, error: "OUT_OF_RANGE" });
    },
  );
});

describe("assertValidPolicy", () => {
  it("accepts the fixture", () => {
    expect(() => assertValidPolicy(FIXTURE_US_TH_V1)).not.toThrow();
  });

  it.each<[string, Partial<FixturePolicy>]>([
    ["fxRateDenominator", { fxRateDenominator: 0n }],
    ["fxRateNumerator", { fxRateNumerator: 0n }],
    ["feeBasisPoints", { feeBasisPoints: 10000n }],
    ["feeBasisPoints", { feeBasisPoints: -1n }],
    ["minDebitMinor", { minDebitMinor: 0n }],
    ["maxDebitMinor", { maxDebitMinor: 50n }],
    ["usdcDecimals", { usdcDecimals: 1n }],
    ["thbDecimals", { thbDecimals: -1n }],
  ])("rejects invalid %s", (_field, override) => {
    expect(() => assertValidPolicy({ ...FIXTURE_US_TH_V1, ...override })).toThrow(RangeError);
  });
});
