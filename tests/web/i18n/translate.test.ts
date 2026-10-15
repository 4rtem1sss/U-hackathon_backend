import { describe, expect, it } from "vitest";
import { en, type MessageKey } from "@/web/i18n/en";
import { th } from "@/web/i18n/th";
import { translate } from "@/web/i18n/translate";

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("i18n", () => {
  it("has a non-empty Thai string for every English key", () => {
    for (const key of Object.keys(en) as MessageKey[]) {
      expect(th[key], key).toBeTruthy();
    }
  });
  it("uses the same placeholders in both languages", () => {
    for (const key of Object.keys(en) as MessageKey[]) {
      expect(placeholders(th[key]), key).toEqual(placeholders(en[key]));
    }
  });
  it("interpolates variables and leaves unknown ones visible", () => {
    expect(translate("en", "review.pay", { amount: "$10.00" })).toBe("Pay $10.00");
    expect(translate("th", "review.pay", { amount: "$10.00" })).toBe("ชำระ $10.00");
    expect(translate("en", "review.pay")).toBe("Pay {amount}");
  });
  it("keeps the required completion copy", () => {
    expect(translate("en", "receipt.summary")).toBe("Demo completed — THB payout simulated.");
  });
});
