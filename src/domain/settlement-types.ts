/**
 * LOCAL minimal copy of the settlement result types from plan section 4.2.
 *
 * The canonical definitions live in `src/settlement/contract.ts` (owned by T6).
 * Integrator: once that file exists, replace this file's body with
 *   export type { SettlementResult, Evidence, Issue } from "@/settlement/contract";
 * The shapes below match plan section 4.2 exactly, so nothing else should change.
 */

export interface Issue {
  code: string;
  message: string;
  retryable: boolean;
}

export interface Evidence {
  chainId: number;
  blockNumber: string;
  blockHash: string;
  tokenAddress: string;
  from: string;
  to: string;
  units: string;
  confirmations: number;
  /** ISO UTC */
  verifiedAt: string;
}

export type SettlementResult =
  | { kind: "NOT_SUBMITTED"; attemptId: string | null; issue?: Issue }
  | { kind: "PENDING"; attemptId: string; txHash: string; phase: "BROADCAST" | "PENDING"; issue?: Issue }
  | { kind: "CONFIRMED"; attemptId: string; txHash: string; evidence: Evidence }
  | { kind: "FAILED"; attemptId: string; txHash: string; reason: string }
  | { kind: "REVIEW"; attemptId: string | null; txHash: string | null; reason: string };
