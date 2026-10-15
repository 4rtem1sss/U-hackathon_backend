import { describe, expect, it } from "vitest";
import { InvalidAmountError, MAX_DIGITS, amountString, formatAmount, isUnsignedIntegerString, parseAmount } from "@/lib/money";

describe("isUnsignedIntegerString()", () => {
  it.each(["0", "1", "100", "10000", "9800000", "9".repeat(MAX_DIGITS)])("accepts %j", (v) => {
    expect(isUnsignedIntegerString(v)).toBe(true);
  });

  it.each([
    "", " ", "-1", "+1", "-0", "1.0", "1.", ".5", "1e3", "1E3", "01", "00", "0x10", "1_000", "1,000",
    " 1", "1 ", "１", "NaN", "Infinity", "9".repeat(MAX_DIGITS + 1),
  ])("rejects %j", (v) => {
    expect(isUnsignedIntegerString(v)).toBe(false);
  });

  it.each([1, 1n, null, undefined, {}, []])("rejects non-string %p", (v) => {
    expect(isUnsignedIntegerString(v)).toBe(false);
  });
});

describe("parseAmount() / formatAmount()", () => {
  it("round-trips without precision loss", () => {
    const big = "123456789012345678901234567890";
    expect(parseAmount(big)).toBe(123456789012345678901234567890n);
    expect(formatAmount(parseAmount(big))).toBe(big);
    expect(parseAmount("0")).toBe(0n);
    expect(formatAmount(9800000n)).toBe("9800000");
  });

  it("throws on invalid input", () => {
    expect(() => parseAmount("1.5")).toThrow(InvalidAmountError);
    expect(() => parseAmount(15)).toThrow(InvalidAmountError);
    expect(() => formatAmount(-1n)).toThrow(InvalidAmountError);
    expect(() => formatAmount(10n ** BigInt(MAX_DIGITS))).toThrow(InvalidAmountError);
  });
});

describe("amountString zod schema", () => {
  it("validates request fields", () => {
    expect(amountString.safeParse("1000").success).toBe(true);
    expect(amountString.safeParse("01000").success).toBe(false);
    expect(amountString.safeParse(1000).success).toBe(false);
  });
});
