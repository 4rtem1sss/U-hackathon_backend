import { describe, expect, it } from "vitest";
import { StaleFenceError } from "@/settlement/contract";
import {
  FakeDependencyError,
  FakeSettlementModule,
  InMemoryFenceGuard,
  assertFakeSettlementAllowed,
  fakeScenario,
} from "@/settlement/fake";
import { buildSettlementIntent } from "@/settlement/intent";
import { assertNoSecrets } from "../contract/settlement.contract";

const config = {
  AVALANCHE_CHAIN_ID: 43113,
  USDC_TOKEN_ADDRESS: "0x5425890298aed601595a70AB815c96711a31Bc65",
  DESTINATION_SETTLEMENT_ADDRESS: "0x000000000000000000000000000000000000dEaD",
};

function setup(id = "tr_a", opts: { seed?: string } = {}) {
  const guard = new InMemoryFenceGuard();
  const settlement = new FakeSettlementModule({ fenceGuard: guard, env: {}, ...opts });
  const intent = buildSettlementIntent({ id, settlementTokenUnits: 9_800_000n }, config);
  const fence = guard.claim(id);
  return { guard, module: settlement, intent, fence };
}

describe("FakeSettlementModule scenarios", () => {
  it("confirmAfter(3): BROADCAST, PENDING, CONFIRMED", async () => {
    const { module, intent, fence } = setup();
    module.script(intent.transferId, fakeScenario.confirmAfter(3));
    const r1 = await module.step(intent, fence);
    const r2 = await module.step(intent, fence);
    const r3 = await module.step(intent, fence);
    expect(r1).toMatchObject({ kind: "PENDING", phase: "BROADCAST" });
    expect(r2).toMatchObject({ kind: "PENDING", phase: "PENDING" });
    expect(r3.kind).toBe("CONFIRMED");
    if (r1.kind !== "PENDING" || r3.kind !== "CONFIRMED") throw new Error("unreachable");
    expect(r3.txHash).toBe(r1.txHash);
    expect(r3.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(module.stats(intent.transferId)).toEqual({
      steps: 3,
      attemptsCreated: 1,
      distinctHashes: 1,
      broadcasts: 1,
      thrown: 0,
    });
  });

  it("hashes are deterministic per seed and transfer", async () => {
    const a = setup("tr_same");
    const b = setup("tr_same");
    const c = setup("tr_same", { seed: "other" });
    const [ra, rb, rc] = await Promise.all([
      a.module.step(a.intent, a.fence),
      b.module.step(b.intent, b.fence),
      c.module.step(c.intent, c.fence),
    ]);
    if (!("txHash" in ra) || !("txHash" in rb) || !("txHash" in rc)) throw new Error("expected hashes");
    expect(ra.txHash).toBe(rb.txHash);
    expect(rc.txHash).not.toBe(ra.txHash);
  });

  it("revert: FAILED with the same hash, then stays FAILED", async () => {
    const { module, intent, fence } = setup();
    module.script(intent.transferId, fakeScenario.revert(2));
    const r1 = await module.step(intent, fence);
    const r2 = await module.step(intent, fence);
    expect(r2).toMatchObject({ kind: "FAILED", txHash: (r1 as { txHash: string }).txHash });
    expect(await module.step(intent, fence)).toEqual(r2);
    expect((await module.getAttempt(intent.transferId))?.phase).toBe("FAILED");
  });

  it("review: REVIEW with hash", async () => {
    const { module, intent, fence } = setup();
    module.script(intent.transferId, fakeScenario.review(1));
    const r = await module.step(intent, fence);
    expect(r).toMatchObject({ kind: "REVIEW", reason: expect.any(String) });
    expect((r as { txHash: string }).txHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("throwOnce: first step throws without creating anything, then proceeds", async () => {
    const { module, intent, fence } = setup();
    module.script(intent.transferId, fakeScenario.throwOnce(fakeScenario.confirmAfter(1)));
    await expect(module.step(intent, fence)).rejects.toBeInstanceOf(FakeDependencyError);
    expect(module.stats(intent.transferId)).toMatchObject({ attemptsCreated: 0, thrown: 1 });
    expect(await module.getAttempt(intent.transferId)).toBeNull();
    expect((await module.step(intent, fence)).kind).toBe("CONFIRMED");
  });

  it("lostResponse: broadcast persisted, step throws, next step reconciles the same hash", async () => {
    const { module, intent, fence } = setup();
    module.script(intent.transferId, fakeScenario.lostResponse(fakeScenario.confirmAfter(3)));
    await expect(module.step(intent, fence)).rejects.toThrow(/lost/);
    const view = await module.getAttempt(intent.transferId);
    expect(view).toMatchObject({ phase: "BROADCAST", txHash: expect.stringMatching(/^0x[0-9a-f]{64}$/) });
    const r2 = await module.step(intent, fence);
    expect(r2).toMatchObject({ kind: "PENDING", phase: "PENDING", txHash: view!.txHash });
    const r3 = await module.step(intent, fence);
    expect(r3).toMatchObject({ kind: "CONFIRMED", txHash: view!.txHash });
    expect(module.stats(intent.transferId)).toMatchObject({ attemptsCreated: 1, distinctHashes: 1, broadcasts: 1 });
  });

  it("prepareFirst: NOT_SUBMITTED with an attemptId and no hash in the view", async () => {
    const { module, intent, fence } = setup();
    module.script(intent.transferId, fakeScenario.prepareFirst(fakeScenario.confirmAfter(2)));
    const r1 = await module.step(intent, fence);
    expect(r1).toMatchObject({ kind: "NOT_SUBMITTED", attemptId: expect.stringMatching(/^stl_/) });
    expect(await module.getAttempt(intent.transferId)).toMatchObject({ phase: "PREPARED", txHash: null, nonce: "0" });
    const r2 = await module.step(intent, fence);
    expect(r2.kind).toBe("CONFIRMED");
  });

  it("returns REVIEW instead of re-sending when the intent changes", async () => {
    const { module, intent, fence } = setup();
    await module.step(intent, fence);
    const r = await module.step({ ...intent, units: "1" }, fence);
    expect(r).toMatchObject({ kind: "REVIEW", reason: expect.stringMatching(/INTENT_MISMATCH/) });
    expect(module.stats(intent.transferId).attemptsCreated).toBe(1);
  });

  it("rejects stale fences and mismatched fences", async () => {
    const { module, intent, fence, guard } = setup();
    guard.claim(intent.transferId);
    await expect(module.step(intent, fence)).rejects.toBeInstanceOf(StaleFenceError);
    await expect(module.step(intent, { transferId: "tr_other", epoch: 1 })).rejects.toThrow(/does not match/);
    expect(module.stats(intent.transferId).attemptsCreated).toBe(0);
  });

  it("evidence and views carry no secrets; preflight labels the fake", async () => {
    const { module, intent, fence } = setup();
    module.script(intent.transferId, fakeScenario.confirmAfter(1));
    const r = await module.step(intent, fence);
    assertNoSecrets(r);
    assertNoSecrets(await module.getAttempt(intent.transferId));
    expect(JSON.stringify(r)).not.toMatch(/signedTx/);
    const pf = await module.preflight();
    expect(pf.ok).toBe(true);
    expect(pf.issues[0]?.code).toBe("FAKE_SETTLEMENT_MODULE");
    expect(module.isFake).toBe(true);
  });

  it("rejects invalid scenarios", () => {
    const { module } = setup();
    expect(() => module.script("tr_x", { outcome: "CONFIRMED", atStep: 0 })).toThrow();
    expect(() => fakeScenario.confirmAfter(0)).toThrow();
  });
});

describe("assertFakeSettlementAllowed()", () => {
  it("allows development/test/unset", () => {
    expect(() => assertFakeSettlementAllowed({})).not.toThrow();
    expect(() => assertFakeSettlementAllowed({ APP_MODE: "test" })).not.toThrow();
    expect(() => assertFakeSettlementAllowed({ APP_MODE: "development" })).not.toThrow();
  });

  it.each(["demo", "production"])("refuses %s unless SETTLEMENT_MODULE=fake", (mode) => {
    expect(() => assertFakeSettlementAllowed({ APP_MODE: mode })).toThrow(/SETTLEMENT_MODULE=fake/);
    expect(() => assertFakeSettlementAllowed({ APP_MODE: mode, SETTLEMENT_MODULE: "fuji" })).toThrow();
    expect(() => assertFakeSettlementAllowed({ APP_MODE: mode, SETTLEMENT_MODULE: "fake" })).not.toThrow();
    expect(
      () => new FakeSettlementModule({ fenceGuard: new InMemoryFenceGuard(), env: { APP_MODE: mode } }),
    ).toThrow();
  });
});

describe("assertNoSecrets()", () => {
  it("flags forbidden keys and long hex strings", () => {
    expect(() => assertNoSecrets({ a: { signedTx: "0x00" } })).toThrow(/signedTx/);
    expect(() => assertNoSecrets({ rawTransaction: "x" })).toThrow();
    expect(() => assertNoSecrets([{ privateKey: "x" }])).toThrow();
    expect(() => assertNoSecrets({ txHash: "0x" + "a".repeat(64) })).not.toThrow();
    expect(() => assertNoSecrets({ blob: "0x" + "a".repeat(65) })).toThrow(/66/);
  });
});
