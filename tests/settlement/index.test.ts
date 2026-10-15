import { afterEach, describe, expect, it } from "vitest";
import {
  FakeSettlementModule,
  InMemoryFenceGuard,
  SettlementModuleNotWiredError,
  getSettlementModule,
  registerFenceGuard,
  resetSettlementModuleForTests,
  resolveSettlementModuleKind,
} from "@/settlement";

afterEach(() => resetSettlementModuleForTests());

describe("resolveSettlementModuleKind()", () => {
  it("defaults to fake in development/test", () => {
    expect(resolveSettlementModuleKind({})).toBe("fake");
    expect(resolveSettlementModuleKind({ APP_MODE: "test" })).toBe("fake");
    expect(resolveSettlementModuleKind({ APP_MODE: "development" })).toBe("fake");
  });

  it("requires an explicit choice in demo/production", () => {
    expect(() => resolveSettlementModuleKind({ APP_MODE: "demo" })).toThrow(/explicitly/);
    expect(() => resolveSettlementModuleKind({ APP_MODE: "production" })).toThrow(/explicitly/);
    expect(resolveSettlementModuleKind({ APP_MODE: "production", SETTLEMENT_MODULE: "fuji" })).toBe("fuji");
    expect(resolveSettlementModuleKind({ APP_MODE: "demo", SETTLEMENT_MODULE: "fake" })).toBe("fake");
  });

  it("rejects unknown values", () => {
    expect(() => resolveSettlementModuleKind({ SETTLEMENT_MODULE: "viem" })).toThrow(/fake.*fuji/);
  });
});

describe("getSettlementModule()", () => {
  it("returns one cached fake module", () => {
    const fenceGuard = new InMemoryFenceGuard();
    const m = getSettlementModule({ fenceGuard, env: {} });
    expect(m).toBeInstanceOf(FakeSettlementModule);
    expect(getSettlementModule()).toBe(m);
  });

  it("uses a registered guard", () => {
    registerFenceGuard(new InMemoryFenceGuard());
    expect(getSettlementModule({ env: { APP_MODE: "test" } })).toBeInstanceOf(FakeSettlementModule);
  });

  it("requires a fence guard", () => {
    expect(() => getSettlementModule({ env: {} })).toThrow(/FenceGuard/);
  });

  it("fuji is not wired yet", () => {
    expect(() =>
      getSettlementModule({ fenceGuard: new InMemoryFenceGuard(), env: { SETTLEMENT_MODULE: "fuji" } }),
    ).toThrow(SettlementModuleNotWiredError);
  });
});
