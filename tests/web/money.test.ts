import { describe, expect, it } from "vitest";
import { estimateQuote, formatMinor, formatRate, formatTokenUnits, minorToInput, parseUsdInput } from "@/web/money";

describe("parseUsdInput", () => {
  it.each([
    ["10", "1000"], ["10.5", "1050"], ["10.50", "1050"], [" 1 ", "100"], ["100.00", "10000"], ["010", "1000"],
  ])("accepts %s", (raw, minor) => {
    expect(parseUsdInput(raw)).toEqual({ ok: true, minor });
  });

  it.each([
    ["", "EMPTY"], ["   ", "EMPTY"], ["abc", "FORMAT"], ["1e2", "FORMAT"], ["-5", "FORMAT"], ["+5", "FORMAT"],
    ["10.505", "FORMAT"], ["10.", "FORMAT"], ["1,000", "FORMAT"], ["๑๐", "FORMAT"],
    ["0.99", "TOO_SMALL"], ["0", "TOO_SMALL"], ["100.01", "TOO_LARGE"],
  ])("rejects %s as %s", (raw, error) => {
    expect(parseUsdInput(raw)).toEqual({ ok: false, error });
  });
});

describe("estimateQuote", () => {
  it("matches the contract example for $10.00", () => {
    expect(estimateQuote("1000")).toEqual({
      sourceDebitMinor: "1000", feeMinor: "20", conversionPrincipalMinor: "980",
      destinationNetMinor: "34300", settlementTokenUnits: "9800000",
    });
  });
  it("rounds the 2% fee up to a whole cent", () => {
    expect(estimateQuote("101").feeMinor).toBe("3");
  });
  it("handles both bounds", () => {
    expect(estimateQuote("100")).toMatchObject({ feeMinor: "2", destinationNetMinor: "3430" });
    expect(estimateQuote("10000")).toMatchObject({ feeMinor: "200", destinationNetMinor: "343000" });
  });
});

describe("formatting", () => {
  it("formats USD and THB minor units", () => {
    expect(formatMinor("1000", "USD")).toBe("$10.00");
    expect(formatMinor("5", "USD")).toBe("$0.05");
    expect(formatMinor("34300", "THB")).toBe("฿343.00");
    expect(formatMinor("343000", "THB")).toBe("฿3,430.00");
    expect(formatMinor("343000", "THB", "th")).toBe("฿3,430.00");
  });
  it("formats the rate without floats", () => {
    expect(formatRate("35", "1")).toBe("1 USD = 35 THB");
    expect(formatRate("71", "2")).toBe("1 USD = 35.5 THB");
  });
  it("formats token units", () => {
    expect(formatTokenUnits("9800000")).toBe("9.80 USDC");
    expect(formatTokenUnits("9812345")).toBe("9.812345 USDC");
    expect(formatTokenUnits("1000000")).toBe("1.00 USDC");
  });
  it("turns minor units back into input text", () => {
    expect(minorToInput("1050")).toBe("10.50");
    expect(minorToInput("100")).toBe("1.00");
  });
});
