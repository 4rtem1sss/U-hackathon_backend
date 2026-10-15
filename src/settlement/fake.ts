/**
 * FAKE settlement module. In-memory, scriptable stand-in for part 4's real
 * Fuji module. NO CHAIN TRANSFER EVER HAPPENS HERE: hashes, blocks and
 * evidence are deterministic fakes.
 *
 * Used by part 3's tests and local development, and as the reference
 * implementation for the contract suite (tests/contract/settlement.contract.ts).
 * It refuses to construct when APP_MODE is `demo` or `production` unless
 * `SETTLEMENT_MODULE=fake` is set explicitly.
 *
 * It follows the same rules as the real module (see contract.ts): persist the
 * (fake) signed bytes before broadcast, idempotent per transferId, never a new
 * nonce/hash because of a thrown or lost step, fence checked before every
 * write, no signed bytes or keys in any result.
 *
 * State lives in process memory: it is lost on restart and is per-instance on
 * serverless hosts.
 */
import { createHash } from "node:crypto";
import { ID_PREFIX, newId } from "@/lib/ids";
import {
  StaleFenceError,
  type AttemptView,
  type Evidence,
  type Fence,
  type FenceGuard,
  type PreflightResult,
  type SettlementAttemptPhase,
  type SettlementIntent,
  type SettlementModule,
  type SettlementResult,
} from "./contract";
import { assertValidIntent } from "./intent";

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

export type FakeOutcome = "CONFIRMED" | "FAILED" | "REVIEW";

/**
 * Script for one transfer. Steps are counted per transfer; a step that throws
 * because of `throwOnce` is not counted.
 */
export interface FakeScenario {
  /** Final outcome once the transaction is broadcast and `atStep` is reached. */
  outcome: FakeOutcome;
  /** Counted step on which the outcome is reported (it is never reported before broadcast). */
  atStep: number;
  /** Step 1 only prepares + persists (returns NOT_SUBMITTED); broadcast happens on step 2. */
  separatePrepare?: boolean;
  /** The next step throws before doing anything (simulates RPC down). One-shot. */
  throwOnce?: boolean;
  /**
   * The broadcast happens and is persisted, then the step throws (response
   * lost). The next step must reconcile the same hash. One-shot.
   */
  lostResponse?: boolean;
}

function positiveInt(n: number, name: string): number {
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`);
  return n;
}

/** Scenario builders. All return plain objects; combine with spread if needed. */
export const fakeScenario = {
  /** PENDING until the n-th step, which returns CONFIRMED (n = 1: confirm on the broadcast step). */
  confirmAfter(n = 2): FakeScenario {
    return { outcome: "CONFIRMED", atStep: positiveInt(n, "confirmAfter(n)") };
  },
  /** Broadcast, then a known on-chain revert reported on step n (default 2). */
  revert(n = 2): FakeScenario {
    return { outcome: "FAILED", atStep: positiveInt(n, "revert(n)") };
  },
  /** Broadcast, then REVIEW reported on step n (default 2). */
  review(n = 2): FakeScenario {
    return { outcome: "REVIEW", atStep: positiveInt(n, "review(n)") };
  },
  /** The next step throws (RPC down) before touching anything; then continue with `base`. */
  throwOnce(base: FakeScenario = fakeScenario.confirmAfter(2)): FakeScenario {
    return { ...base, throwOnce: true };
  },
  /** The broadcast step loses its response (throws after broadcasting); then continue with `base`. */
  lostResponse(base: FakeScenario = fakeScenario.confirmAfter(2)): FakeScenario {
    return { ...base, lostResponse: true };
  },
  /** Step 1 returns NOT_SUBMITTED (prepared + persisted only); broadcast on step 2. */
  prepareFirst(base: FakeScenario = fakeScenario.confirmAfter(3)): FakeScenario {
    return { ...base, separatePrepare: true };
  },
} as const;

export const DEFAULT_FAKE_SCENARIO: FakeScenario = fakeScenario.confirmAfter(2);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Simulated dependency failure (RPC down, lost response). Part 3 treats it like any thrown step. */
export class FakeDependencyError extends Error {
  readonly code = "FAKE_DEPENDENCY_UNAVAILABLE" as const;
  constructor(message: string) {
    super(`[fake settlement] ${message}`);
    this.name = "FakeDependencyError";
  }
}

// ---------------------------------------------------------------------------
// Environment guard
// ---------------------------------------------------------------------------

/**
 * Throws unless the fake may run: always allowed in development/test (or when
 * APP_MODE is unset); in demo/production only with `SETTLEMENT_MODULE=fake`.
 */
export function assertFakeSettlementAllowed(env: Record<string, string | undefined> = process.env): void {
  const mode = env.APP_MODE?.trim() || "development";
  if ((mode === "demo" || mode === "production") && env.SETTLEMENT_MODULE?.trim() !== "fake") {
    throw new Error(
      `FakeSettlementModule refused: APP_MODE=${mode} requires SETTLEMENT_MODULE=fake to be set explicitly to use the fake.`,
    );
  }
}

// ---------------------------------------------------------------------------
// In-memory fence guard (tests and dev only)
// ---------------------------------------------------------------------------

/**
 * In-memory {@link FenceGuard} mirroring part 3's claim semantics: `claim()`
 * increments the transfer's epoch and returns the new fence; older fences
 * become stale. For tests and the fake only; production uses the DB guard (T2).
 */
export class InMemoryFenceGuard implements FenceGuard {
  private readonly epochs = new Map<string, number>();

  /** Take (or steal) the claim: epoch + 1. */
  claim(transferId: string): Fence {
    const epoch = (this.epochs.get(transferId) ?? 0) + 1;
    this.epochs.set(transferId, epoch);
    return { transferId, epoch };
  }

  currentEpoch(transferId: string): number | null {
    return this.epochs.get(transferId) ?? null;
  }

  async assertFence(fence: Fence): Promise<void> {
    const current = this.currentEpoch(fence.transferId);
    if (current === null || current !== fence.epoch) throw new StaleFenceError(fence, current);
  }
}

// ---------------------------------------------------------------------------
// Fake module
// ---------------------------------------------------------------------------

/** Fixed fake signer address (not a real key). */
export const FAKE_SIGNER_ADDRESS = "0x00000000000000000000000000000000fa4e5161" as const;

interface FakeAttempt {
  attemptId: string;
  transferId: string;
  intent: SettlementIntent;
  nonce: number;
  /** Fake "signed bytes". Internal only: never copied into a result or view. */
  signedTx: string;
  txHash: string;
  phase: SettlementAttemptPhase;
  evidence: Evidence | null;
  reason: string | null;
  createdFence: number;
  createdAt: string;
  updatedAt: string;
  broadcasts: number;
}

interface TransferState {
  scenario: FakeScenario;
  steps: number;
  throwPending: boolean;
  lostPending: boolean;
  attempts: FakeAttempt[];
  hashes: Set<string>;
  thrown: number;
}

export interface FakeTransferStats {
  /** Counted (non-throwOnce) steps. */
  steps: number;
  /** Attempts (nonces) created for the transfer. Must stay <= 1. */
  attemptsCreated: number;
  /** Distinct tx hashes created for the transfer. Must stay <= 1. */
  distinctHashes: number;
  /** Times the stored bytes were (re)broadcast. */
  broadcasts: number;
  /** Steps that threw a simulated dependency error. */
  thrown: number;
}

export interface FakeSettlementModuleOptions {
  fenceGuard: FenceGuard;
  /** Scenario for transfers without an explicit script. Default: confirmAfter(2). */
  defaultScenario?: FakeScenario;
  /** Reported confirmations in evidence. Default 2. */
  confirmations?: number;
  /** Seed for deterministic hashes. Default "fake". */
  seed?: string;
  /** Clock for timestamps (tests). */
  now?: () => Date;
  /** Env used for the demo/production guard. Default process.env. */
  env?: Record<string, string | undefined>;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * FAKE in-memory settlement module (see file header). Scriptable per
 * transfer via {@link FakeSettlementModule.script}.
 */
export class FakeSettlementModule implements SettlementModule {
  /** Marker so callers and snapshots can label simulated settlement. */
  readonly isFake = true as const;
  readonly name = "fake" as const;

  private readonly fenceGuard: FenceGuard;
  private readonly defaultScenario: FakeScenario;
  private readonly confirmations: number;
  private readonly seed: string;
  private readonly now: () => Date;
  private readonly transfers = new Map<string, TransferState>();
  private nextNonce = 0;

  constructor(options: FakeSettlementModuleOptions) {
    assertFakeSettlementAllowed(options.env ?? process.env);
    this.fenceGuard = options.fenceGuard;
    this.defaultScenario = options.defaultScenario ?? DEFAULT_FAKE_SCENARIO;
    positiveInt(this.defaultScenario.atStep, "defaultScenario.atStep");
    this.confirmations = options.confirmations ?? 2;
    this.seed = options.seed ?? "fake";
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Set the scenario for a transfer. Before the first step: the whole script.
   * Afterwards: replaces the remaining script (counters are kept) and re-arms
   * `throwOnce` / `lostResponse` if set.
   */
  script(transferId: string, scenario: FakeScenario): void {
    positiveInt(scenario.atStep, "scenario.atStep");
    const st = this.state(transferId);
    st.scenario = { ...scenario };
    st.throwPending = scenario.throwOnce === true;
    st.lostPending = scenario.lostResponse === true;
  }

  /** Arm a one-shot "RPC down" for the next step of this transfer. */
  failNextStep(transferId: string): void {
    this.state(transferId).throwPending = true;
  }

  /** Arm a one-shot lost response for the next broadcast of this transfer. */
  loseNextBroadcastResponse(transferId: string): void {
    this.state(transferId).lostPending = true;
  }

  /** Counters for assertions (attempts/hashes must never exceed 1 per transfer). */
  stats(transferId: string): FakeTransferStats {
    const st = this.transfers.get(transferId);
    if (!st) return { steps: 0, attemptsCreated: 0, distinctHashes: 0, broadcasts: 0, thrown: 0 };
    return {
      steps: st.steps,
      attemptsCreated: st.attempts.length,
      distinctHashes: st.hashes.size,
      broadcasts: st.attempts.reduce((n, a) => n + a.broadcasts, 0),
      thrown: st.thrown,
    };
  }

  async step(intent: SettlementIntent, fence: Fence): Promise<SettlementResult> {
    assertValidIntent(intent);
    if (fence.transferId !== intent.transferId) {
      throw new Error("[fake settlement] fence.transferId does not match intent.transferId");
    }
    // The real module re-checks the fence inside each write transaction. The
    // fake has no transaction; everything after this await runs synchronously,
    // so checking once here covers every write of this step.
    await this.fenceGuard.assertFence(fence);

    const st = this.state(intent.transferId);

    if (st.throwPending) {
      st.throwPending = false;
      st.thrown += 1;
      throw new FakeDependencyError("RPC unavailable (simulated)");
    }

    let attempt = st.attempts.at(-1);

    if (attempt && !this.matchesIntent(attempt, intent)) {
      // Never "fix" a mismatch by sending again.
      return {
        kind: "REVIEW",
        attemptId: attempt.attemptId,
        txHash: attempt.phase === "PREPARED" ? null : attempt.txHash,
        reason: "INTENT_MISMATCH: the existing attempt does not match this intent.",
      };
    }

    if (attempt && isTerminal(attempt.phase)) return this.resultOf(attempt);

    st.steps += 1;

    if (!attempt) {
      attempt = this.prepare(st, intent, fence);
      if (st.scenario.separatePrepare && st.steps === 1) {
        return { kind: "NOT_SUBMITTED", attemptId: attempt.attemptId };
      }
    }

    let broadcastThisStep = false;
    if (attempt.phase === "PREPARED") {
      // Broadcast the STORED bytes (same hash on every retry).
      attempt.broadcasts += 1;
      attempt.phase = "BROADCAST";
      attempt.updatedAt = this.isoNow();
      broadcastThisStep = true;
      if (st.lostPending) {
        st.lostPending = false;
        st.thrown += 1;
        throw new FakeDependencyError("broadcast response lost (simulated)");
      }
    }

    if (st.steps >= st.scenario.atStep) {
      this.finish(attempt, st.scenario.outcome);
      return this.resultOf(attempt);
    }

    if (!broadcastThisStep && attempt.phase === "BROADCAST") {
      attempt.phase = "PENDING";
      attempt.updatedAt = this.isoNow();
    }
    return this.resultOf(attempt);
  }

  async getAttempt(transferId: string): Promise<AttemptView | null> {
    const attempt = this.transfers.get(transferId)?.attempts.at(-1);
    return attempt ? this.viewOf(attempt) : null;
  }

  async preflight(): Promise<PreflightResult> {
    return {
      ok: true,
      issues: [
        {
          code: "FAKE_SETTLEMENT_MODULE",
          message: "Fake settlement module in use: no on-chain transfer happens.",
          retryable: false,
        },
      ],
    };
  }

  // -------------------------------------------------------------------------

  private state(transferId: string): TransferState {
    let st = this.transfers.get(transferId);
    if (!st) {
      const scenario = { ...this.defaultScenario };
      st = {
        scenario,
        steps: 0,
        throwPending: scenario.throwOnce === true,
        lostPending: scenario.lostResponse === true,
        attempts: [],
        hashes: new Set(),
        thrown: 0,
      };
      this.transfers.set(transferId, st);
    }
    return st;
  }

  /** "Sign" and persist before any broadcast. */
  private prepare(st: TransferState, intent: SettlementIntent, fence: Fence): FakeAttempt {
    const attemptNo = st.attempts.length + 1;
    const nonce = this.nextNonce++;
    const signedTx = `0x02${sha256Hex(`${this.seed}:signed:${intent.transferId}:${attemptNo}:${nonce}`)}`;
    const txHash = `0x${sha256Hex(`${this.seed}:tx:${intent.transferId}:${attemptNo}`)}`;
    const ts = this.isoNow();
    const attempt: FakeAttempt = {
      attemptId: newId(ID_PREFIX.settlementAttempt),
      transferId: intent.transferId,
      intent: { ...intent },
      nonce,
      signedTx,
      txHash,
      phase: "PREPARED",
      evidence: null,
      reason: null,
      createdFence: fence.epoch,
      createdAt: ts,
      updatedAt: ts,
      broadcasts: 0,
    };
    st.attempts.push(attempt);
    st.hashes.add(txHash);
    return attempt;
  }

  private finish(attempt: FakeAttempt, outcome: FakeOutcome): void {
    const ts = this.isoNow();
    attempt.updatedAt = ts;
    if (outcome === "CONFIRMED") {
      attempt.phase = "CONFIRMED";
      attempt.evidence = {
        chainId: attempt.intent.chainId,
        blockNumber: String(1_000_000 + attempt.nonce),
        blockHash: `0x${sha256Hex(`${this.seed}:block:${attempt.txHash}`)}`,
        tokenAddress: attempt.intent.tokenAddress,
        from: FAKE_SIGNER_ADDRESS,
        to: attempt.intent.destination,
        units: attempt.intent.units,
        confirmations: this.confirmations,
        verifiedAt: ts,
      };
    } else if (outcome === "FAILED") {
      attempt.phase = "FAILED";
      attempt.reason = "Transaction reverted on chain (simulated).";
    } else {
      attempt.phase = "REVIEW";
      attempt.reason = "Settlement needs manual review (simulated).";
    }
  }

  private matchesIntent(attempt: FakeAttempt, intent: SettlementIntent): boolean {
    const a = attempt.intent;
    return (
      a.chainId === intent.chainId &&
      sameAddress(a.tokenAddress, intent.tokenAddress) &&
      sameAddress(a.destination, intent.destination) &&
      a.units === intent.units
    );
  }

  private resultOf(a: FakeAttempt): SettlementResult {
    switch (a.phase) {
      case "PREPARED":
        return { kind: "NOT_SUBMITTED", attemptId: a.attemptId };
      case "BROADCAST":
      case "PENDING":
        return { kind: "PENDING", attemptId: a.attemptId, txHash: a.txHash, phase: a.phase };
      case "CONFIRMED":
        return { kind: "CONFIRMED", attemptId: a.attemptId, txHash: a.txHash, evidence: { ...a.evidence! } };
      case "FAILED":
        return { kind: "FAILED", attemptId: a.attemptId, txHash: a.txHash, reason: a.reason ?? "reverted" };
      case "REVIEW":
        return { kind: "REVIEW", attemptId: a.attemptId, txHash: a.txHash, reason: a.reason ?? "review" };
    }
  }

  private viewOf(a: FakeAttempt): AttemptView {
    return {
      attemptId: a.attemptId,
      transferId: a.transferId,
      chainId: a.intent.chainId,
      tokenAddress: a.intent.tokenAddress,
      signer: FAKE_SIGNER_ADDRESS,
      destination: a.intent.destination,
      units: a.intent.units,
      nonce: String(a.nonce),
      txHash: a.phase === "PREPARED" ? null : a.txHash,
      phase: a.phase,
      evidence: a.evidence ? { ...a.evidence } : null,
      reason: a.reason,
      createdFence: a.createdFence,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    };
  }

  private isoNow(): string {
    return this.now().toISOString();
  }
}

function isTerminal(phase: SettlementAttemptPhase): boolean {
  return phase === "CONFIRMED" || phase === "FAILED" || phase === "REVIEW";
}
