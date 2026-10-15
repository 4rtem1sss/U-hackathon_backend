import { ID_PREFIX, newId } from "@/lib/ids";
import {
  FUJI_CHAIN_ID,
  type AttemptView,
  type Evidence,
  type Fence,
  type FenceGuard,
  type SettlementIntent,
  type SettlementModule,
  type SettlementResult,
} from "../contract";
import { assertValidIntent } from "../intent";
import {
  FujiNotReadyError,
  FujiUnsafeTransactionError,
  type FujiAttemptRecord,
  type FujiAttemptStore,
  type FujiAttemptUpdate,
  type FujiGateway,
  type FujiInspection,
} from "./types";

const MAX_NUMERIC_38 = BigInt("9".repeat(38));
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

export interface FujiSettlementModuleOptions<Tx> {
  fenceGuard: FenceGuard<Tx>;
  store: FujiAttemptStore<Tx>;
  gateway: FujiGateway;
  tokenAddress: string;
  destination: string;
}
function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function evidence(value: unknown): Evidence | null {
  if (!value || typeof value !== "object") return null;
  const ev = value as Partial<Evidence>;
  return typeof ev.chainId === "number" &&
    typeof ev.blockNumber === "string" &&
    typeof ev.blockHash === "string" &&
    typeof ev.tokenAddress === "string" &&
    typeof ev.from === "string" &&
    typeof ev.to === "string" &&
    typeof ev.units === "string" &&
    typeof ev.confirmations === "number" &&
    typeof ev.verifiedAt === "string"
      ? (ev as Evidence)
      : null;
}

function conflictReason(attempt: FujiAttemptRecord, intent: SettlementIntent, signer: string): string | null {
  if (attempt.chainId !== intent.chainId) return "INTENT_CHAIN_MISMATCH";
  if (!sameAddress(attempt.tokenAddress, intent.tokenAddress)) return "INTENT_TOKEN_MISMATCH";
  if (!sameAddress(attempt.destination, intent.destination)) return "INTENT_DESTINATION_MISMATCH";
  if (attempt.units !== intent.units) return "INTENT_UNITS_MISMATCH";
  if (!sameAddress(attempt.signer, signer)) return "SIGNER_MISMATCH";
  return null;
}

function resultFor(attempt: FujiAttemptRecord): SettlementResult {
  switch (attempt.phase) {
    case "PREPARED":
      return { kind: "NOT_SUBMITTED", attemptId: attempt.attemptId };
    case "BROADCAST":
    case "PENDING":
      return { kind: "PENDING", attemptId: attempt.attemptId, txHash: attempt.txHash, phase: attempt.phase };
    case "CONFIRMED": {
      const ev = evidence(attempt.storedOutcome);
      return ev
        ? { kind: "CONFIRMED", attemptId: attempt.attemptId, txHash: attempt.txHash, evidence: ev }
        : { kind: "REVIEW", attemptId: attempt.attemptId, txHash: attempt.txHash, reason: "PERSISTED_EVIDENCE_INVALID" };
    }
    case "FAILED":
      return { kind: "FAILED", attemptId: attempt.attemptId, txHash: attempt.txHash, reason: "TRANSACTION_REVERTED" };
    case "REVIEW":
      return {
        kind: "REVIEW",
        attemptId: attempt.attemptId,
        txHash: attempt.txHash,
        reason: "ON_CHAIN_EVIDENCE_INCONSISTENT",
      };
  }
}

function attemptView(attempt: FujiAttemptRecord): AttemptView {
  return {
    attemptId: attempt.attemptId,
    transferId: attempt.transferId,
    chainId: attempt.chainId,
    tokenAddress: attempt.tokenAddress,
    signer: attempt.signer,
    destination: attempt.destination,
    units: attempt.units,
    nonce: attempt.nonce,
    txHash: attempt.txHash,
    phase: attempt.phase,
    evidence: attempt.phase === "CONFIRMED" ? evidence(attempt.storedOutcome) : null,
    reason:
      attempt.phase === "FAILED"
        ? "TRANSACTION_REVERTED"
        : attempt.phase === "REVIEW"
          ? "ON_CHAIN_EVIDENCE_INCONSISTENT"
          : null,
    createdFence: attempt.createdFence,
    createdAt: attempt.createdAt.toISOString(),
    updatedAt: attempt.updatedAt.toISOString(),
  };
}

function pgUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "23505");
}

/** Real persisted Fuji state machine behind the frozen SettlementModule contract. */
export class FujiSettlementModule<Tx = unknown> implements SettlementModule {
  readonly name = "fuji" as const;
  readonly isFake = false as const;

  private readonly fenceGuard: FenceGuard<Tx>;
  private readonly store: FujiAttemptStore<Tx>;
  private readonly gateway: FujiGateway;
  private readonly tokenAddress: string;
  private readonly destination: string;

  constructor(options: FujiSettlementModuleOptions<Tx>) {
    this.fenceGuard = options.fenceGuard;
    this.store = options.store;
    this.gateway = options.gateway;
    this.tokenAddress = options.tokenAddress;
    this.destination = options.destination;
  }

  private intentProblem(intent: SettlementIntent): string | null {
    if (intent.chainId !== FUJI_CHAIN_ID) return "INTENT_CHAIN_MISMATCH";
    if (!sameAddress(intent.tokenAddress, this.tokenAddress)) return "INTENT_TOKEN_MISMATCH";
    if (!sameAddress(intent.destination, this.destination)) return "INTENT_DESTINATION_MISMATCH";
    if (BigInt(intent.units) > MAX_NUMERIC_38) return "INTENT_UNITS_EXCEED_DATABASE_RANGE";
    return null;
  }

  private async update(fence: Fence, update: FujiAttemptUpdate): Promise<FujiAttemptRecord> {
    const changed = await this.store.transaction(async (tx) => {
      await this.fenceGuard.assertFence(fence, tx);
      return this.store.update(tx, update);
    });
    return changed ?? (await this.requireAttempt(fence.transferId));
  }

  private async requireAttempt(transferId: string): Promise<FujiAttemptRecord> {
    const attempt = await this.store.latest(transferId);
    if (!attempt) throw new Error("Persisted Fuji settlement attempt disappeared.");
    return attempt;
  }

  private async createAttempt(intent: SettlementIntent, fence: Fence): Promise<FujiAttemptRecord | null> {
    // Reject stale callers before any nonce lookup or signing.
    await this.fenceGuard.assertFence(fence);

    const prepared = await this.gateway.prepare(intent);
    if (!HASH_RE.test(prepared.txHash) || prepared.signer.toLowerCase() !== this.gateway.signerAddress.toLowerCase()) {
      throw new Error("Fuji signer returned invalid transaction metadata.");
    }

    try {
      return await this.store.transaction(async (tx) => {
        await this.fenceGuard.assertFence(fence, tx);
        const existing = await this.store.latest(intent.transferId, tx);
        if (existing) return existing;
        const busy = await this.store.unresolvedForSigner(this.gateway.signerAddress, tx);
        if (busy) return null;
        return this.store.insert(tx, {
          attemptId: newId(ID_PREFIX.settlementAttempt),
          intent,
          signer: prepared.signer,
          nonce: prepared.nonce,
          signedTx: prepared.signedTx,
          txHash: prepared.txHash,
          createdFence: fence.epoch,
        });
      });
    } catch (error) {
      if (!pgUniqueViolation(error)) throw error;
      return this.store.latest(intent.transferId);
    }
  }

  private async persistInspection(
    attempt: FujiAttemptRecord,
    fence: Fence,
    inspection: FujiInspection,
  ): Promise<SettlementResult> {
    if (inspection.kind === "PENDING") {
      if (attempt.phase === "PENDING") {
        return {
          kind: "PENDING",
          attemptId: attempt.attemptId,
          txHash: attempt.txHash,
          phase: "PENDING",
          ...(inspection.issue ? { issue: inspection.issue } : {}),
        };
      }
      const pending = await this.update(fence, {
        attemptId: attempt.attemptId,
        expectedPhases: ["BROADCAST"],
        phase: "PENDING",
      });
      const result = resultFor(pending);
      return result.kind === "PENDING" && inspection.issue ? { ...result, issue: inspection.issue } : result;
    }

    if (inspection.kind === "CONFIRMED") {
      return resultFor(
        await this.update(fence, {
          attemptId: attempt.attemptId,
          expectedPhases: ["BROADCAST", "PENDING"],
          phase: "CONFIRMED",
          receiptBlockNumber: inspection.evidence.blockNumber,
          receiptBlockHash: inspection.evidence.blockHash,
          storedOutcome: inspection.evidence,
        }),
      );
    }

    return resultFor(
      await this.update(fence, {
        attemptId: attempt.attemptId,
        expectedPhases: ["BROADCAST", "PENDING"],
        phase: inspection.kind,
        ...(inspection.blockNumber ? { receiptBlockNumber: inspection.blockNumber } : {}),
        ...(inspection.blockHash ? { receiptBlockHash: inspection.blockHash } : {}),
      }),
    );
  }

  async step(intent: SettlementIntent, fence: Fence): Promise<SettlementResult> {
    assertValidIntent(intent);
    if (fence.transferId !== intent.transferId) throw new Error("Fence transferId does not match settlement intent.");

    const configuredProblem = this.intentProblem(intent);
    if (configuredProblem) return { kind: "REVIEW", attemptId: null, txHash: null, reason: configuredProblem };

    let attempt = await this.store.latest(intent.transferId);
    if (attempt) {
      const problem = conflictReason(attempt, intent, this.gateway.signerAddress);
      if (problem) return { kind: "REVIEW", attemptId: attempt.attemptId, txHash: attempt.txHash, reason: problem };
      if (attempt.phase === "CONFIRMED" || attempt.phase === "FAILED" || attempt.phase === "REVIEW") {
        return resultFor(attempt);
      }
    }

    if (!attempt) {
      try {
        attempt = await this.createAttempt(intent, fence);
      } catch (error) {
        if (error instanceof FujiNotReadyError) {
          return error.issue.retryable
            ? { kind: "NOT_SUBMITTED", attemptId: null, issue: error.issue }
            : { kind: "REVIEW", attemptId: null, txHash: null, reason: error.issue.code };
        }
        throw error;
      }
      if (!attempt) {
        return {
          kind: "NOT_SUBMITTED",
          attemptId: null,
          issue: {
            code: "SIGNER_BUSY_OR_UNSAFE_CONFIGURATION",
            message: "Settlement signer is busy or Fuji configuration requires review.",
            retryable: true,
          },
        };
      }
      const problem = conflictReason(attempt, intent, this.gateway.signerAddress);
      return problem
        ? { kind: "REVIEW", attemptId: attempt.attemptId, txHash: attempt.txHash, reason: problem }
        : resultFor(attempt);
    }

    // Every non-terminal continuation proves the caller still owns the claim before RPC.
    await this.fenceGuard.assertFence(fence);

    if (attempt.phase === "PREPARED") {
      let networkHash: `0x${string}`;
      try {
        networkHash = await this.gateway.broadcast(attempt);
      } catch (error) {
        if (!(error instanceof FujiUnsafeTransactionError)) throw error;
        return resultFor(
          await this.update(fence, {
            attemptId: attempt.attemptId,
            expectedPhases: ["PREPARED"],
            phase: "REVIEW",
          }),
        );
      }
      if (networkHash.toLowerCase() !== attempt.txHash.toLowerCase()) {
        return resultFor(
          await this.update(fence, {
            attemptId: attempt.attemptId,
            expectedPhases: ["PREPARED"],
            phase: "REVIEW",
          }),
        );
      }
      const broadcast = await this.update(fence, {
        attemptId: attempt.attemptId,
        expectedPhases: ["PREPARED"],
        phase: "BROADCAST",
      });
      return resultFor(broadcast);
    }

    return this.persistInspection(attempt, fence, await this.gateway.inspect(attempt));
  }

  async getAttempt(transferId: string): Promise<AttemptView | null> {
    const attempt = await this.store.latest(transferId);
    return attempt ? attemptView(attempt) : null;
  }

  preflight() {
    return this.gateway.preflight();
  }
}
