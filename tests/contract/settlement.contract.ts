/**
 * Settlement contract suite: every SettlementModule (part 3's fake, part 4's
 * real Fuji module) must pass it. See docs/settlement-contract.md.
 *
 * Usage (in a *.test.ts file):
 *
 *   runSettlementContractSuite("my module", async () => ({ module, newTransfer, makeStale, countAttempts, ... }));
 *
 * The harness gives the suite fresh transfers with a valid fence, a way to
 * make a fence stale (bump claim_epoch), and attempt counts read straight from
 * the module's storage (e.g. `SELECT count(*) FROM settlement_attempts`).
 * Fault injection hooks are optional; tests that need them are skipped when
 * they are absent.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isStaleFenceError,
  type Fence,
  type SettlementIntent,
  type SettlementModule,
  type SettlementResult,
} from "@/settlement/contract";

export interface AttemptCounts {
  /** settlement_attempts rows (nonces) ever created for the transfer. */
  attempts: number;
  /** Distinct tx hashes ever created for the transfer. */
  hashes: number;
}

export interface SettlementContractHarness {
  module: SettlementModule;
  /**
   * A fresh transfer that is ready to settle (real module: transfer row exists,
   * claimed) with its intent and current fence. When the harness supports
   * outcomes, the transfer must eventually CONFIRM unless told otherwise.
   */
  newTransfer(): Promise<{ intent: SettlementIntent; fence: Fence }>;
  /** Make `fence` stale (another caller claimed the transfer). Returns the new current fence. */
  makeStale(fence: Fence): Promise<Fence>;
  /** Count attempts/hashes ever created for the transfer, from storage. */
  countAttempts(transferId: string): Promise<AttemptCounts>;
  /** Optional: the next step for this transfer throws before doing anything (RPC down). */
  failNextStep?(transferId: string): Promise<void> | void;
  /** Optional: the next broadcast for this transfer succeeds but the step throws (lost response). */
  loseNextBroadcastResponse?(transferId: string): Promise<void> | void;
  /** Optional: arrange for this transfer to end in a known on-chain revert. */
  scriptRevert?(transferId: string): Promise<void> | void;
  /** Wait between steps while polling (real chain). Default 0. */
  stepIntervalMs?: number;
  /** Max steps to reach a terminal result. Default 20. */
  maxSteps?: number;
  cleanup?(): Promise<void> | void;
}

const FORBIDDEN_KEYS = new Set(["signedtx", "rawtransaction", "privatekey", "signedtransaction", "rawtx", "serializedtransaction"]);
const LONG_HEX_RE = /0x[0-9a-fA-F]{65,}/;

/**
 * Throws if `value` (a result or attempt view) contains a forbidden key or a
 * 0x string longer than 66 chars (anything bigger than a 32-byte hash, e.g.
 * signed tx bytes). Exported so callers can reuse it.
 */
export function assertNoSecrets(value: unknown, path = "result"): void {
  if (typeof value === "string") {
    if (LONG_HEX_RE.test(value)) throw new Error(`${path} contains a 0x string longer than 66 chars`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoSecrets(v, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(k.toLowerCase())) throw new Error(`${path} contains forbidden key "${k}"`);
      assertNoSecrets(v, `${path}.${k}`);
    }
  }
}

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const TERMINAL = new Set<SettlementResult["kind"]>(["CONFIRMED", "FAILED", "REVIEW"]);

function txHashOf(r: SettlementResult): string | null {
  return "txHash" in r ? r.txHash : null;
}

export function runSettlementContractSuite(
  name: string,
  factory: () => Promise<SettlementContractHarness> | SettlementContractHarness,
): void {
  describe(`SettlementModule contract: ${name}`, () => {
    let h: SettlementContractHarness;
    const seenResults: SettlementResult[] = [];

    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    /** Every result passes through here, so the no-secrets rule is checked on all of them. */
    async function step(intent: SettlementIntent, fence: Fence): Promise<SettlementResult> {
      const r = await h.module.step(intent, fence);
      assertNoSecrets(r);
      checkShape(r);
      seenResults.push(r);
      return r;
    }

    function checkShape(r: SettlementResult): void {
      const hash = txHashOf(r);
      if (hash !== null) expect(hash).toMatch(TX_HASH_RE);
      if (r.kind !== "NOT_SUBMITTED" && r.kind !== "REVIEW") expect(r.attemptId).toEqual(expect.any(String));
    }

    /** Step until terminal (or maxSteps), tolerating nothing: a throw fails the test. */
    async function driveToTerminal(intent: SettlementIntent, fence: Fence): Promise<SettlementResult[]> {
      const out: SettlementResult[] = [];
      for (let i = 0; i < (h.maxSteps ?? 20); i++) {
        const r = await step(intent, fence);
        out.push(r);
        if (TERMINAL.has(r.kind)) return out;
        if (h.stepIntervalMs) await sleep(h.stepIntervalMs);
      }
      return out;
    }

    function distinctHashes(results: SettlementResult[]): Set<string> {
      return new Set(results.map(txHashOf).filter((x): x is string => x !== null));
    }

    beforeEach(async () => {
      seenResults.length = 0;
      h = await factory();
    });

    afterEach(async () => {
      await h.cleanup?.();
    });

    it("step is idempotent: repeated steps never create a second attempt or hash", async () => {
      const { intent, fence } = await h.newTransfer();
      const results = await driveToTerminal(intent, fence);
      const last = results.at(-1)!;
      expect(TERMINAL.has(last.kind)).toBe(true);

      // Keep stepping after the terminal result: same answer, nothing new.
      for (let i = 0; i < 3; i++) {
        const again = await step(intent, fence);
        expect(again.kind).toBe(last.kind);
        expect(txHashOf(again)).toBe(txHashOf(last));
        if ("attemptId" in again && "attemptId" in last) expect(again.attemptId).toBe(last.attemptId);
      }

      expect(distinctHashes(seenResults).size).toBeLessThanOrEqual(1);
      const ids = new Set(seenResults.map((r) => r.attemptId).filter((x) => x !== null));
      expect(ids.size).toBeLessThanOrEqual(1);
      expect(await h.countAttempts(intent.transferId)).toEqual({ attempts: 1, hashes: 1 });
    });

    it("concurrent steps with the same fence still create at most one attempt", async () => {
      const { intent, fence } = await h.newTransfer();
      const settled = await Promise.allSettled([h.module.step(intent, fence), h.module.step(intent, fence)]);
      for (const s of settled) if (s.status === "fulfilled") assertNoSecrets(s.value);
      const hashes = new Set(
        settled.flatMap((s) => (s.status === "fulfilled" ? [txHashOf(s.value)] : [])).filter((x) => x !== null),
      );
      expect(hashes.size).toBeLessThanOrEqual(1);
      const counts = await h.countAttempts(intent.transferId);
      expect(counts.attempts).toBeLessThanOrEqual(1);
      expect(counts.hashes).toBeLessThanOrEqual(1);
    });

    it("after a thrown step (RPC down), the next step continues the same tx hash", async (ctx) => {
      if (!h.failNextStep) return ctx.skip();
      const { intent, fence } = await h.newTransfer();

      // Reach a broadcast hash first.
      let first: SettlementResult | undefined;
      for (let i = 0; i < (h.maxSteps ?? 20); i++) {
        first = await step(intent, fence);
        if (txHashOf(first) !== null) break;
      }
      const hash = txHashOf(first!);
      expect(hash).not.toBeNull();
      if (TERMINAL.has(first!.kind)) return; // already done; idempotency covered elsewhere

      await h.failNextStep(intent.transferId);
      await expect(h.module.step(intent, fence)).rejects.toThrow();

      const results = await driveToTerminal(intent, fence);
      for (const r of results) {
        const hr = txHashOf(r);
        if (hr !== null) expect(hr).toBe(hash);
      }
      expect(await h.countAttempts(intent.transferId)).toEqual({ attempts: 1, hashes: 1 });
    });

    it("after a lost broadcast response, the next step reconciles the same tx hash", async (ctx) => {
      if (!h.loseNextBroadcastResponse) return ctx.skip();
      const { intent, fence } = await h.newTransfer();
      await h.loseNextBroadcastResponse(intent.transferId);

      let threw = false;
      for (let i = 0; i < (h.maxSteps ?? 20) && !threw; i++) {
        const r = await step(intent, fence).catch(() => null);
        if (r === null) threw = true;
        else expect(txHashOf(r)).toBeNull(); // nothing broadcast before the lost one
      }
      expect(threw).toBe(true);

      // The broadcast happened: the hash must already be persisted.
      const view = await h.module.getAttempt(intent.transferId);
      expect(view).not.toBeNull();
      assertNoSecrets(view, "attemptView");
      expect(view!.txHash).toMatch(TX_HASH_RE);

      const next = await step(intent, fence);
      expect(txHashOf(next)).toBe(view!.txHash);
      const results = [next, ...(TERMINAL.has(next.kind) ? [] : await driveToTerminal(intent, fence))];
      for (const r of results) {
        const hr = txHashOf(r);
        if (hr !== null) expect(hr).toBe(view!.txHash);
      }
      expect(await h.countAttempts(intent.transferId)).toEqual({ attempts: 1, hashes: 1 });
    });

    it("a stale fence is rejected with StaleFenceError and creates no attempt", async () => {
      const { intent, fence } = await h.newTransfer();
      const current = await h.makeStale(fence);
      expect(current.epoch).not.toBe(fence.epoch);

      const err = await h.module.step(intent, fence).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).not.toBeNull();
      expect(isStaleFenceError(err)).toBe(true);
      expect(await h.countAttempts(intent.transferId)).toEqual({ attempts: 0, hashes: 0 });
      expect(await h.module.getAttempt(intent.transferId)).toBeNull();

      // The current holder can proceed.
      const r = await step(intent, current);
      expect(["NOT_SUBMITTED", "PENDING", "CONFIRMED"]).toContain(r.kind);
    });

    it("a fence that goes stale mid-flight cannot continue the attempt", async () => {
      const { intent, fence } = await h.newTransfer();
      const r1 = await step(intent, fence);
      if (TERMINAL.has(r1.kind)) return;
      const before = await h.countAttempts(intent.transferId);
      await h.makeStale(fence);
      const err = await h.module.step(intent, fence).then(
        () => null,
        (e: unknown) => e,
      );
      expect(isStaleFenceError(err)).toBe(true);
      expect(await h.countAttempts(intent.transferId)).toEqual(before);
    });

    it("CONFIRMED evidence matches the intent exactly", async () => {
      const { intent, fence } = await h.newTransfer();
      const results = await driveToTerminal(intent, fence);
      const last = results.at(-1)!;
      expect(last.kind).toBe("CONFIRMED");
      if (last.kind !== "CONFIRMED") return;
      const ev = last.evidence;
      expect(ev.chainId).toBe(intent.chainId);
      expect(ev.units).toBe(intent.units);
      expect(ev.to.toLowerCase()).toBe(intent.destination.toLowerCase());
      expect(ev.tokenAddress.toLowerCase()).toBe(intent.tokenAddress.toLowerCase());
      expect(ev.blockNumber).toMatch(/^[0-9]+$/);
      expect(ev.blockHash).toMatch(TX_HASH_RE);
      expect(ev.from).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(ev.confirmations).toBeGreaterThanOrEqual(1);
      expect(Number.isNaN(Date.parse(ev.verifiedAt))).toBe(false);

      const view = await h.module.getAttempt(intent.transferId);
      assertNoSecrets(view, "attemptView");
      expect(view).toMatchObject({ phase: "CONFIRMED", txHash: last.txHash, attemptId: last.attemptId });
    });

    it("a known revert is FAILED and is never retried with a new attempt", async (ctx) => {
      if (!h.scriptRevert) return ctx.skip();
      const { intent, fence } = await h.newTransfer();
      await h.scriptRevert(intent.transferId);
      const results = await driveToTerminal(intent, fence);
      const last = results.at(-1)!;
      expect(last.kind).toBe("FAILED");
      const again = await step(intent, fence);
      expect(again).toEqual(last);
      expect(await h.countAttempts(intent.transferId)).toEqual({ attempts: 1, hashes: 1 });
    });

    it("getAttempt has no side effects", async () => {
      const { intent, fence } = await h.newTransfer();
      expect(await h.module.getAttempt(intent.transferId)).toBeNull();
      expect(await h.countAttempts(intent.transferId)).toEqual({ attempts: 0, hashes: 0 });

      const r = await step(intent, fence);
      const v1 = await h.module.getAttempt(intent.transferId);
      const counts = await h.countAttempts(intent.transferId);
      for (let i = 0; i < 5; i++) {
        const v = await h.module.getAttempt(intent.transferId);
        assertNoSecrets(v, "attemptView");
        expect(v).toEqual(v1);
      }
      expect(await h.countAttempts(intent.transferId)).toEqual(counts);
      if (v1) {
        expect(v1.transferId).toBe(intent.transferId);
        expect(v1.units).toBe(intent.units);
        if (r.kind !== "NOT_SUBMITTED") expect(v1.txHash).toBe(txHashOf(r));
      }
    });

    it("results and attempt views never carry signed bytes or keys", async () => {
      const { intent, fence } = await h.newTransfer();
      await driveToTerminal(intent, fence);
      expect(seenResults.length).toBeGreaterThan(0);
      for (const r of seenResults) assertNoSecrets(r);
      assertNoSecrets(await h.module.getAttempt(intent.transferId), "attemptView");
      const pf = await h.module.preflight();
      assertNoSecrets(pf, "preflight");
      expect(typeof pf.ok).toBe("boolean");
      expect(Array.isArray(pf.issues)).toBe(true);
    });
  });
}
