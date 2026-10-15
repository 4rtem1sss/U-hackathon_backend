import "server-only";
import type { Queryable } from "@/db";
import { mapRow } from "@/db/map";
import type { PayoutAttemptRow } from "@/db/types";
import type { DemoScenario } from "@/domain";

/**
 * Local THB payout simulator (api-contract sections 7-8). No real money moves.
 *
 * Persisted and deterministic: the outcome of a payout attempt is stored on its
 * `payout_attempts` row, keyed by the attempt's stable `request_id`.
 *
 * - Scenario PAYOUT_FAILED fails attempt #1; everything else (including every
 *   deliberate retry, attempt_no >= 2) is PAID.
 * - Reference: `payout_sim_<attemptId>`.
 * - Idempotent per request_id: once an attempt is PAID or FAILED, executing the
 *   same request_id again returns the stored outcome and writes nothing.
 * - UNKNOWN (only via the injectable test hook) is stored as status UNKNOWN; the
 *   next execution with the same request_id queries again and resolves it.
 *
 * Run it inside the caller's transaction (it locks the attempt row), so the
 * stored outcome and the transfer transition commit together.
 */

export type PayoutOutcome = "PAID" | "FAILED" | "UNKNOWN";

export interface PayoutSimResult {
  outcome: PayoutOutcome;
  /** Simulator reference (`payout_sim_<attemptId>`). */
  reference: string;
  attemptId: string;
  requestId: string;
  attemptNo: number;
}

export interface PayoutSimInput {
  /** Stable request ID of the payout attempt (unique). */
  requestId: string;
  demoScenario: DemoScenario;
}

/** Test hook: return true to report UNKNOWN for this (unresolved) execution. */
export type UnknownHook = (attempt: { transferId: string; requestId: string; attemptNo: number }) => boolean;

export interface PayoutSimulatorOptions {
  unknownHook?: UnknownHook;
}

export interface PayoutSimulator {
  execute(db: Queryable, input: PayoutSimInput): Promise<PayoutSimResult>;
}

export function payoutReference(attemptId: string): string {
  return `payout_sim_${attemptId}`;
}

/** Deterministic final outcome for an attempt. */
export function decidePayout(demoScenario: DemoScenario, attemptNo: number): "PAID" | "FAILED" {
  return demoScenario === "PAYOUT_FAILED" && attemptNo === 1 ? "FAILED" : "PAID";
}

/** Hook that reports UNKNOWN exactly once per request_id. */
export function unknownOncePerRequest(): UnknownHook {
  const seen = new Set<string>();
  return ({ requestId }) => {
    if (seen.has(requestId)) return false;
    seen.add(requestId);
    return true;
  };
}

export class PayoutAttemptNotFoundError extends Error {
  constructor(requestId: string) {
    super(`payout attempt not found for request ${requestId}`);
    this.name = "PayoutAttemptNotFoundError";
  }
}

export function createPayoutSimulator(options: PayoutSimulatorOptions = {}): PayoutSimulator {
  return {
    async execute(db, input) {
      const { rows } = await db.query(
        "SELECT * FROM payout_attempts WHERE request_id = $1 FOR UPDATE",
        [input.requestId],
      );
      if (!rows[0]) throw new PayoutAttemptNotFoundError(input.requestId);
      const attempt = mapRow<PayoutAttemptRow>(rows[0]);
      const reference = payoutReference(attempt.id);
      const base = { reference, attemptId: attempt.id, requestId: attempt.requestId, attemptNo: attempt.attemptNo };

      // Already decided: return the stored outcome (idempotent per request_id).
      if (attempt.status === "PAID" || attempt.status === "FAILED") {
        return { ...base, outcome: attempt.status, reference: attempt.reference ?? reference };
      }

      const unknown =
        options.unknownHook?.({ transferId: attempt.transferId, requestId: attempt.requestId, attemptNo: attempt.attemptNo }) ??
        false;
      const outcome: PayoutOutcome = unknown ? "UNKNOWN" : decidePayout(input.demoScenario, attempt.attemptNo);
      await db.query(
        `UPDATE payout_attempts
            SET status = $2, reference = $3, updated_at = now()
          WHERE id = $1`,
        [attempt.id, outcome, outcome === "UNKNOWN" ? attempt.reference : reference],
      );
      return { ...base, outcome };
    },
  };
}

let current: PayoutSimulator | undefined;

/** Process-wide default simulator. */
export function getPayoutSimulator(): PayoutSimulator {
  current ??= createPayoutSimulator();
  return current;
}

/** Test helper: replace (or with undefined, reset) the process-wide simulator. */
export function setPayoutSimulatorForTests(sim: PayoutSimulator | undefined): void {
  current = sim;
}
