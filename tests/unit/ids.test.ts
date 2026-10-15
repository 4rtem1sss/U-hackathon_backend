import { describe, expect, it } from "vitest";
import { ID_PREFIX, isId, newId, newRequestId } from "@/lib/ids";

describe("ids", () => {
  it("generates unique prefixed ids", () => {
    const a = newId(ID_PREFIX.transfer);
    const b = newId(ID_PREFIX.transfer);
    expect(a).toMatch(/^tr_[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
    expect(isId(a, "tr")).toBe(true);
    expect(isId(a, "qt")).toBe(false);
    expect(newRequestId()).toMatch(/^req_/);
  });

  it("rejects bad prefixes", () => {
    expect(() => newId("")).toThrow();
    expect(() => newId("Tr")).toThrow();
    expect(() => newId("a_b")).toThrow();
  });
});
