/**
 * Settlement contract between part 3 (application backend) and part 4 (Fuji
 * blockchain module). Source: part3-work-plan.md section 4. Owned jointly; treat
 * the shapes below as frozen: change them only with both parts agreeing.
 *
 * Boundary rules (plan §4.1):
 *
 * 1. Part 3 decides *when*; part 4 decides *how* on chain. Part 3 claims the
 *    transfer, builds the {@link SettlementIntent} from the accepted quote and
 *    server config, calls {@link SettlementModule.step}, then maps the result to
 *    the public transfer status in one DB transaction (plan §4.3).
 * 2. Part 4 writes ONLY the `settlement_attempts` table. Part 3 writes only
 *    `transfers`, `transfer_events`, funding/payout and idempotency tables.
 *    Neither side writes the other's tables.
 * 3. Part 4 never marks a transfer settled or complete; it returns evidence.
 *    Part 3 never signs or broadcasts and never talks to the chain.
 * 4. No value in the intent comes from the browser: destination and token come
 *    from server config, units from the accepted quote.
 * 5. Raw signed bytes and private keys never leave part 4's module and never
 *    appear in any {@link SettlementResult}, {@link AttemptView}, log line or
 *    API response.
 *
 * This file contains types only (plus two small error classes), so it is safe
 * to import from anywhere on the server.
 */

/** Avalanche Fuji C-Chain. The only chain this demo settles on. */
export const FUJI_CHAIN_ID = 43113 as const;

export type HexAddress = `0x${string}`;

/**
 * Immutable instruction from part 3 to part 4: "move exactly `units` of
 * `tokenAddress` to `destination` for this transfer".
 *
 * Every field is server-owned: `tokenAddress` and `destination` come from
 * server config (`USDC_TOKEN_ADDRESS`, `DESTINATION_SETTLEMENT_ADDRESS`),
 * `units` from the accepted quote. Build it with `buildSettlementIntent`
 * (src/settlement/intent.ts); never from request input.
 *
 * The intent for one `transferId` never changes. A module that finds an
 * existing attempt whose chain/token/destination/units differ from the intent
 * must not "fix" it by sending again; it returns `REVIEW` (or throws) instead.
 */
export interface SettlementIntent {
  transferId: string;
  chainId: typeof FUJI_CHAIN_ID;
  /** From config. */
  tokenAddress: HexAddress;
  /** Allowlisted, from config. */
  destination: HexAddress;
  /** Unsigned integer string of token base units, from the accepted quote (e.g. "9800000"). */
  units: string;
}

/**
 * Proof that the caller currently holds the claim on the transfer
 * (plan §4.4). `epoch` is the `transfers.claim_epoch` value returned by part 3's
 * `claimTransfer()`. Any later claim increments the epoch, which makes this
 * fence stale.
 */
export interface Fence {
  transferId: string;
  /** `transfers.claim_epoch` held by this caller. */
  epoch: number;
}

/** A safe, user-displayable problem description. Never contains secrets or raw bytes. */
export interface Issue {
  code: string;
  message: string;
  retryable: boolean;
}

/**
 * Verified on-chain evidence of the settlement transfer. Part 4 fills it only
 * after checking: chain ID, receipt status success, token contract, sender,
 * destination, the exact ERC-20 `Transfer` event amount, and the agreed
 * confirmation policy. Part 3 stores it verbatim on the transfer.
 *
 * Invariants checked by the contract suite: `chainId`, `tokenAddress`, `to`
 * and `units` equal the intent (addresses compared case-insensitively).
 */
export interface Evidence {
  chainId: number;
  /** Decimal integer string. */
  blockNumber: string;
  blockHash: string;
  tokenAddress: string;
  /** Signer address the tokens were sent from. */
  from: string;
  /** Destination; must equal `intent.destination`. */
  to: string;
  /** Exact `Transfer` event value; must equal `intent.units`. */
  units: string;
  confirmations: number;
  /** ISO 8601 UTC timestamp of verification. */
  verifiedAt: string;
}

/**
 * Outcome of one bounded {@link SettlementModule.step}. These are internal
 * outcomes; part 3 maps them to the public enums (plan §4.3):
 *
 * | kind          | transfer status    | settlement substatus |
 * | ------------- | ------------------ | -------------------- |
 * | NOT_SUBMITTED | SETTLEMENT_PENDING | PREPARING            |
 * | PENDING       | SETTLEMENT_PENDING | BROADCAST / PENDING  |
 * | CONFIRMED     | SETTLED            | CONFIRMED            |
 * | FAILED        | SETTLEMENT_FAILED  | FAILED               |
 * | REVIEW        | REVIEW_REQUIRED    | REVIEW_REQUIRED      |
 * | (thrown)      | unchanged          | unchanged            |
 *
 * A result NEVER contains signed transaction bytes, private keys or any other
 * secret (enforced by the contract suite: no `signedTx` / `rawTransaction` /
 * `privateKey` keys and no `0x` string longer than 66 characters).
 */
export type SettlementResult =
  /** Nothing has been broadcast yet; safe to call `step` again. */
  | { kind: "NOT_SUBMITTED"; attemptId: string | null; issue?: Issue }
  /**
   * A transaction with `txHash` may be on chain; outcome unknown. Keep
   * reconciling this same hash. Never treat this as permission to send again.
   */
  | { kind: "PENDING"; attemptId: string; txHash: string; phase: "BROADCAST" | "PENDING"; issue?: Issue }
  /** Verified success. */
  | { kind: "CONFIRMED"; attemptId: string; txHash: string; evidence: Evidence }
  /** Known on-chain revert only (receipt status 0). Not used for timeouts or RPC errors. */
  | { kind: "FAILED"; attemptId: string; txHash: string; reason: string }
  /** Unsafe or inconsistent situation; a human must look. Part 3 holds the transfer. */
  | { kind: "REVIEW"; attemptId: string | null; txHash: string | null; reason: string };

export type SettlementResultKind = SettlementResult["kind"];

/** Lifecycle of a row in `settlement_attempts` (column `phase`). */
export type SettlementAttemptPhase = "PREPARED" | "BROADCAST" | "PENDING" | "CONFIRMED" | "FAILED" | "REVIEW";

/**
 * Read-only projection of the latest `settlement_attempts` row for a transfer,
 * for status display and debugging. Deliberately has no `signedTx` field.
 */
export interface AttemptView {
  attemptId: string;
  transferId: string;
  chainId: number;
  tokenAddress: string;
  signer: string;
  destination: string;
  units: string;
  /** Decimal string; null before a nonce is reserved. */
  nonce: string | null;
  txHash: string | null;
  phase: SettlementAttemptPhase;
  evidence: Evidence | null;
  /** Reason for FAILED / REVIEW, if any. */
  reason: string | null;
  createdFence: number;
  /** ISO 8601 UTC. */
  createdAt: string;
  /** ISO 8601 UTC. */
  updatedAt: string;
}

export interface PreflightResult {
  ok: boolean;
  issues: Issue[];
}

/**
 * Part 4's module. Part 3 calls it in-process (or via the optional internal
 * HTTP route, plan §4.5, with identical types and rules).
 */
export interface SettlementModule {
  /**
   * Advance settlement for one transfer by one bounded step.
   *
   * Rules every implementation must follow:
   *
   * - **Bounded.** Returns (or throws) in well under ~10 s, so it fits inside
   *   one `/advance` request on Vercel. Never waits for confirmations in a loop;
   *   return `PENDING` and let the next call check again.
   * - **Idempotent per `transferId`.** Finds the existing attempt for the
   *   transfer and continues it: prepare + persist → broadcast the stored bytes
   *   → check the receipt. Repeated calls never create a second attempt, nonce
   *   or tx hash for the same transfer.
   * - **Persist before broadcast.** The signed bytes, tx hash and nonce are
   *   committed to `settlement_attempts` *before* the transaction is broadcast.
   *   Broadcasting always sends the stored bytes, so a retry re-sends the same
   *   transaction (same hash), never a re-signed one.
   * - **Never a new nonce/payment because of a timeout.** A timeout, lost
   *   response, RPC error or "not found yet" leaves the outcome unknown: keep
   *   reconciling the same hash (`PENDING`) or escalate to `REVIEW`. Only a
   *   known on-chain revert is `FAILED`.
   * - **Fence re-checked inside the write transaction.** Every DB write the
   *   module makes (insert attempt, phase updates) calls
   *   {@link FenceGuard.assertFence} inside the same transaction, after taking
   *   the row lock, and aborts if it throws {@link StaleFenceError}. A stale
   *   caller therefore cannot persist or broadcast a new transaction. No DB
   *   transaction stays open across an RPC wait.
   * - **Writes only `settlement_attempts`.** Never updates `transfers` or any
   *   other part 3 table; returns evidence instead.
   * - **No secrets in results.** Results never contain signed bytes or keys.
   *
   * Throwing means "dependency unavailable, nothing decided": part 3 leaves the
   * transfer unchanged, records `lastIssue = DEPENDENCY_UNAVAILABLE` and calls
   * `step` again later. A thrown {@link StaleFenceError} means the caller lost
   * its claim and must stop.
   */
  step(intent: SettlementIntent, fence: Fence): Promise<SettlementResult>;

  /**
   * Read-only: latest persisted attempt for status display. Must have no side
   * effects: no RPC calls, no writes, no progress of the attempt.
   */
  getAttempt(transferId: string): Promise<AttemptView | null>;

  /** Startup/health: chain ID, token code + decimals, signer balances. No writes. */
  preflight(): Promise<PreflightResult>;
}

/**
 * Fence check supplied by part 3 to the module (constructor/factory
 * injection). The DB implementation (task T2) does
 * `SELECT claim_epoch FROM transfers WHERE id = $1 FOR UPDATE` and throws
 * {@link StaleFenceError} when it differs from `fence.epoch`.
 *
 * The module calls it inside each transaction that writes
 * `settlement_attempts`, passing that transaction's client as `tx` so the row
 * lock and the attempt write commit together. Implementations that need no
 * transaction (the in-memory fake) ignore `tx`.
 */
export interface FenceGuard<Tx = unknown> {
  /** Resolves if `fence` is current; rejects with {@link StaleFenceError} otherwise. */
  assertFence(fence: Fence, tx?: Tx): Promise<void>;
}

/** The caller's claim epoch is no longer current; it must stop without writing. */
export class StaleFenceError extends Error {
  readonly code = "STALE_FENCE" as const;
  readonly fence: Fence;
  /** Current epoch when known (null when the transfer row was not found). */
  readonly currentEpoch: number | null;

  constructor(fence: Fence, currentEpoch: number | null = null) {
    super(
      `Stale settlement fence for transfer ${fence.transferId}: held epoch ${fence.epoch}, current ${
        currentEpoch === null ? "unknown" : currentEpoch
      }.`,
    );
    this.name = "StaleFenceError";
    this.fence = fence;
    this.currentEpoch = currentEpoch;
  }
}

export function isStaleFenceError(err: unknown): err is StaleFenceError {
  return err instanceof StaleFenceError || (err instanceof Error && (err as { code?: unknown }).code === "STALE_FENCE");
}

/** Intent built from server config/quote is invalid (bad config or amount). */
export class SettlementIntentError extends Error {
  readonly code = "INVALID_SETTLEMENT_INTENT" as const;
  constructor(message: string) {
    super(message);
    this.name = "SettlementIntentError";
  }
}
