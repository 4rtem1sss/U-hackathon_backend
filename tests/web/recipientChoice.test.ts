import { describe, expect, it } from "vitest";
import type { Recipient } from "@/web/api/types";
import { pickRecipient } from "@/web/recipientChoice";

const r = (id: string): Recipient => ({
  id, name: id, country: "TH", currency: "THB", bankLabel: "SCB", accountDisplay: "••0001", isSynthetic: true,
});

describe("pickRecipient", () => {
  it("uses the stored id when it is in the list", () => {
    expect(pickRecipient([r("a"), r("b")], "b")?.id).toBe("b");
  });
  it("falls back to the first recipient for a stale or missing id", () => {
    expect(pickRecipient([r("a"), r("b")], "gone")?.id).toBe("a");
    expect(pickRecipient([r("a")], null)?.id).toBe("a");
  });
  it("returns null for an empty list", () => {
    expect(pickRecipient([], "a")).toBeNull();
  });
});
