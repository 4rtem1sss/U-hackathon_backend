import { describe, expect, it } from "vitest";
import { getOrCreateKey, uuidV4 } from "@/web/idempotency";
import { memoryStore } from "@/web/storage";

describe("idempotency keys", () => {
  it("generates v4 UUIDs without crypto.randomUUID", () => {
    expect(uuidV4()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it("reuses the same key for the same logical action", () => {
    const store = memoryStore();
    const a = getOrCreateKey("transfer:quote_1", store);
    expect(getOrCreateKey("transfer:quote_1", store)).toBe(a);
    expect(getOrCreateKey("transfer:quote_2", store)).not.toBe(a);
  });
});
