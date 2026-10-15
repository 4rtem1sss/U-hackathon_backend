import { describe, expect, it } from "vitest";
import {
  accountDisplayFromNumber,
  bankLabel,
  newRecipientBody,
  normalizeAccountNumber,
  THAI_BANKS,
} from "@/domain/recipients";

const ok = (input: unknown) => newRecipientBody.safeParse(input);
const base = { name: "Somchai Jaidee", bankCode: "KBANK", accountNumber: "1234567890" };

describe("recipient rules", () => {
  it("lists the seven Thai banks", () => {
    expect(THAI_BANKS.map((b) => b.code)).toEqual(["KBANK", "SCB", "BBL", "KTB", "BAY", "TTB", "GSB"]);
    expect(bankLabel("BAY")).toBe("Krungsri");
  });

  it("accepts Latin and Thai names, trimming whitespace", () => {
    expect(ok({ ...base, name: "  Somchai Jaidee " }).data?.name).toBe("Somchai Jaidee");
    expect(ok({ ...base, name: "สมชาย ใจดี" }).success).toBe(true);
    expect(ok({ ...base, name: "น้ำฝน" }).success).toBe(true);
    expect(ok({ ...base, name: "O'Neil-Smith Jr." }).success).toBe(true);
  });

  it("rejects empty, whitespace-only, too long, and symbol names", () => {
    expect(ok({ ...base, name: "" }).success).toBe(false);
    expect(ok({ ...base, name: "   " }).success).toBe(false);
    expect(ok({ ...base, name: "a".repeat(61) }).success).toBe(false);
    expect(ok({ ...base, name: "Bob <script>" }).success).toBe(false);
    expect(ok({ ...base, name: "Agent 007" }).success).toBe(false);
  });

  it("normalizes account numbers with dashes and spaces", () => {
    expect(normalizeAccountNumber("123-4-56789-0")).toBe("1234567890");
    expect(ok({ ...base, accountNumber: "123 4 56789 0" }).data?.accountNumber).toBe("1234567890");
  });

  it("accepts 10 to 12 digits only", () => {
    expect(ok({ ...base, accountNumber: "123456789" }).success).toBe(false);
    expect(ok({ ...base, accountNumber: "123456789012" }).success).toBe(true);
    expect(ok({ ...base, accountNumber: "1234567890123" }).success).toBe(false);
    expect(ok({ ...base, accountNumber: "12345abcde" }).success).toBe(false);
  });

  it("rejects unknown banks and extra fields", () => {
    expect(ok({ ...base, bankCode: "CITI" }).success).toBe(false);
    expect(ok({ ...base, accountDisplay: "x" }).success).toBe(false);
  });

  it("builds a last-4 display", () => {
    expect(accountDisplayFromNumber("1234567890")).toBe("••7890");
  });
});
