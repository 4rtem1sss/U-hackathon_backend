import type { Evidence, Issue, SettlementAttemptPhase, SettlementIntent } from "../contract";

/** Complete private row used by the Fuji module. signedTx must never leave this boundary. */
export interface FujiAttemptRecord {
  attemptId: string;
  transferId: string;
  chainId: number;
  tokenAddress: string;
  signer: string;
  destination: string;
  units: string;
  nonce: string;
  signedTx: `0x${string}`;
  txHash: `0x${string}`;
  phase: SettlementAttemptPhase;
  receiptBlockNumber: string | null;
  receiptBlockHash: string | null;
  /** Evidence on CONFIRMED; a private reason envelope on FAILED/REVIEW. */
  storedOutcome: unknown;
  createdFence: number;
  createdAt: Date;
  updatedAt: Date;
}
export interface NewFujiAttempt {
  attemptId: string;
  intent: SettlementIntent;
  signer: string;
  nonce: string;
  signedTx: `0x${string}`;
  txHash: `0x${string}`;
  createdFence: number;
}

export interface FujiAttemptUpdate {
  attemptId: string;
  expectedPhases: SettlementAttemptPhase[];
  phase: SettlementAttemptPhase;
  receiptBlockNumber?: string;
  receiptBlockHash?: string;
  storedOutcome?: unknown;
}

/** Storage boundary keeps the state machine testable without a live database. */
export interface FujiAttemptStore<Tx = unknown> {
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  latest(transferId: string, tx?: Tx): Promise<FujiAttemptRecord | null>;
  unresolvedForSigner(signer: string, tx: Tx): Promise<FujiAttemptRecord | null>;
  insert(tx: Tx, attempt: NewFujiAttempt): Promise<FujiAttemptRecord>;
  update(tx: Tx, update: FujiAttemptUpdate): Promise<FujiAttemptRecord | null>;
}

export interface PreparedFujiTransaction {
  signer: string;
  nonce: string;
  signedTx: `0x${string}`;
  txHash: `0x${string}`;
}

export type FujiInspection =
  | { kind: "PENDING"; issue?: Issue }
  | { kind: "CONFIRMED"; evidence: Evidence }
  | { kind: "FAILED"; reason: string; blockNumber: string; blockHash: string }
  | { kind: "REVIEW"; reason: string; blockNumber?: string; blockHash?: string };

/** RPC/signing boundary. Automated tests inject a deterministic local mock. */
export interface FujiGateway {
  readonly signerAddress: string;
  prepare(intent: SettlementIntent): Promise<PreparedFujiTransaction>;
  broadcast(attempt: FujiAttemptRecord): Promise<`0x${string}`>;
  inspect(attempt: FujiAttemptRecord): Promise<FujiInspection>;
  preflight(): Promise<{ ok: boolean; issues: Issue[] }>;
}

export class FujiDependencyError extends Error {
  readonly code = "FUJI_DEPENDENCY_UNAVAILABLE" as const;

  constructor(message = "Avalanche Fuji is temporarily unavailable.") {
    super(message);
    this.name = "FujiDependencyError";
  }
}

export class FujiNotReadyError extends Error {
  readonly issue: Issue;

  constructor(issue: Issue) {
    super(issue.message);
    this.name = "FujiNotReadyError";
    this.issue = issue;
  }
}

/** Persisted signed bytes do not match their immutable attempt metadata. */
export class FujiUnsafeTransactionError extends Error {
  readonly code = "FUJI_SIGNED_TRANSACTION_UNSAFE" as const;

  constructor(readonly reason: string) {
    super("Persisted Fuji transaction failed local integrity validation.");
    this.name = "FujiUnsafeTransactionError";
  }
}
