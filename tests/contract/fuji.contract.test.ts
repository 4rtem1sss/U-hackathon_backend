import { createHash, randomUUID } from "node:crypto";
import { StaleFenceError, type Evidence, type Fence, type SettlementIntent } from "@/settlement/contract";
import { buildSettlementIntent } from "@/settlement/intent";
import {
  FujiSettlementModule,
  type FujiAttemptRecord,
  type FujiAttemptStore,
  type FujiGateway,
  type FujiInspection,
  type FujiAttemptUpdate,
  type NewFujiAttempt,
} from "@/settlement/fuji";
import { runSettlementContractSuite } from "./settlement.contract";

const TOKEN = "0x5425890298aed601595a70AB815c96711a31Bc65";
const DESTINATION = "0x000000000000000000000000000000000000dEaD";
const SIGNER = "0x1111111111111111111111111111111111111111";

function hash(input: string): `0x${string}` {
  return `0x${createHash("sha256").update(input).digest("hex")}`;
}

function clone(row: FujiAttemptRecord): FujiAttemptRecord {
  return { ...row, createdAt: new Date(row.createdAt), updatedAt: new Date(row.updatedAt) };
}

class MemoryAttemptStore implements FujiAttemptStore<object> {
  readonly rows: FujiAttemptRecord[] = [];
  private queue = Promise.resolve();

  async transaction<T>(fn: (tx: object) => Promise<T>): Promise<T> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const previous = this.queue;
    this.queue = previous.then(() => gate);
    await previous;
    const snapshot = this.rows.map(clone);
    try {
      return await fn({ transaction: true });
    } catch (error) {
      this.rows.splice(0, this.rows.length, ...snapshot);
      throw error;
    } finally {
      release();
    }
  }

  async latest(transferId: string): Promise<FujiAttemptRecord | null> {
    return [...this.rows].reverse().find((row) => row.transferId === transferId) ?? null;
  }

  async unresolvedForSigner(signer: string): Promise<FujiAttemptRecord | null> {
    return (
      this.rows.find(
        (row) =>
          row.signer.toLowerCase() === signer.toLowerCase() &&
          (row.phase === "PREPARED" || row.phase === "BROADCAST" || row.phase === "PENDING"),
      ) ?? null
    );
  }

  async insert(_tx: object, attempt: NewFujiAttempt): Promise<FujiAttemptRecord> {
    if (this.rows.some((row) => row.transferId === attempt.intent.transferId)) {
      const error = Object.assign(new Error("duplicate transfer"), { code: "23505" });
      throw error;
    }
    if (
      this.rows.some(
        (row) =>
          row.chainId === attempt.intent.chainId &&
          row.signer.toLowerCase() === attempt.signer.toLowerCase() &&
          (row.nonce === attempt.nonce || ["PREPARED", "BROADCAST", "PENDING"].includes(row.phase)),
      )
    ) {
      const error = Object.assign(new Error("signer constraint"), { code: "23505" });
      throw error;
    }
    const now = new Date();
    const row: FujiAttemptRecord = {
      attemptId: attempt.attemptId,
      transferId: attempt.intent.transferId,
      chainId: attempt.intent.chainId,
      tokenAddress: attempt.intent.tokenAddress.toLowerCase(),
      signer: attempt.signer.toLowerCase(),
      destination: attempt.intent.destination.toLowerCase(),
      units: attempt.intent.units,
      nonce: attempt.nonce,
      signedTx: attempt.signedTx,
      txHash: attempt.txHash,
      phase: "PREPARED",
      receiptBlockNumber: null,
      receiptBlockHash: null,
      storedOutcome: null,
      createdFence: attempt.createdFence,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.push(row);
    return clone(row);
  }

  async update(_tx: object, update: FujiAttemptUpdate): Promise<FujiAttemptRecord | null> {
    const row = this.rows.find(
      (candidate) => candidate.attemptId === update.attemptId && update.expectedPhases.includes(candidate.phase),
    );
    if (!row) return null;
    row.phase = update.phase;
    if (update.receiptBlockNumber !== undefined) row.receiptBlockNumber = update.receiptBlockNumber;
    if (update.receiptBlockHash !== undefined) row.receiptBlockHash = update.receiptBlockHash;
    if (update.storedOutcome !== undefined) row.storedOutcome = update.storedOutcome;
    row.updatedAt = new Date();
    return clone(row);
  }
}

class MemoryFenceGuard {
  private readonly epochs = new Map<string, number>();

  claim(transferId: string): Fence {
    const epoch = (this.epochs.get(transferId) ?? 0) + 1;
    this.epochs.set(transferId, epoch);
    return { transferId, epoch };
  }

  async assertFence(fence: Fence): Promise<void> {
    const current = this.epochs.get(fence.transferId) ?? null;
    if (current !== fence.epoch) throw new StaleFenceError(fence, current);
  }
}

class MockFujiGateway implements FujiGateway {
  readonly signerAddress = SIGNER;
  private nonce = 0;
  private readonly bySignedTx = new Map<string, { transferId: string; txHash: `0x${string}` }>();
  private readonly broadcasted = new Set<string>();
  private readonly lose = new Set<string>();
  private readonly fail = new Set<string>();
  private readonly revert = new Set<string>();
  private readonly inspections = new Map<string, number>();

  async prepare(intent: SettlementIntent) {
    const nonce = this.nonce++;
    const txHash = hash(`${intent.transferId}:${nonce}:${intent.units}`);
    const signedTx = `0x02${txHash.slice(2)}${"ab".repeat(40)}` as `0x${string}`;
    this.bySignedTx.set(signedTx, { transferId: intent.transferId, txHash });
    return { signer: SIGNER, nonce: String(nonce), signedTx, txHash };
  }

  async broadcast(attempt: FujiAttemptRecord): Promise<`0x${string}`> {
    const tx = this.bySignedTx.get(attempt.signedTx);
    if (!tx) throw new Error("unknown persisted bytes");
    this.broadcasted.add(tx.transferId);
    if (this.lose.delete(tx.transferId)) throw new Error("mock lost broadcast response");
    return tx.txHash;
  }

  async inspect(attempt: FujiAttemptRecord): Promise<FujiInspection> {
    if (this.fail.delete(attempt.transferId)) throw new Error("mock RPC unavailable");
    if (!this.broadcasted.has(attempt.transferId)) return { kind: "PENDING" };
    if (this.revert.has(attempt.transferId)) {
      return { kind: "FAILED", reason: "TRANSACTION_REVERTED", blockNumber: "100", blockHash: hash("block") };
    }
    const count = (this.inspections.get(attempt.transferId) ?? 0) + 1;
    this.inspections.set(attempt.transferId, count);
    if (count === 1) return { kind: "PENDING" };
    const evidence: Evidence = {
      chainId: 43113,
      blockNumber: "100",
      blockHash: hash("block"),
      tokenAddress: attempt.tokenAddress,
      from: attempt.signer,
      to: attempt.destination,
      units: attempt.units,
      confirmations: 2,
      verifiedAt: new Date().toISOString(),
    };
    return { kind: "CONFIRMED", evidence };
  }

  async preflight() {
    return { ok: true, issues: [] };
  }

  failNext(transferId: string) {
    this.fail.add(transferId);
  }

  loseNext(transferId: string) {
    this.lose.add(transferId);
  }

  scriptRevert(transferId: string) {
    this.revert.add(transferId);
  }
}

runSettlementContractSuite("FujiSettlementModule (mock Fuji chain)", () => {
  const store = new MemoryAttemptStore();
  const guard = new MemoryFenceGuard();
  const gateway = new MockFujiGateway();
  const settlement = new FujiSettlementModule({
    fenceGuard: guard,
    store,
    gateway,
    tokenAddress: TOKEN,
    destination: DESTINATION,
  });
  return {
    module: settlement,
    async newTransfer() {
      const transferId = `tr_${randomUUID()}`;
      return {
        intent: buildSettlementIntent(
          { id: transferId, settlementTokenUnits: 9_800_000n },
          { AVALANCHE_CHAIN_ID: 43113, USDC_TOKEN_ADDRESS: TOKEN, DESTINATION_SETTLEMENT_ADDRESS: DESTINATION },
        ),
        fence: guard.claim(transferId),
      };
    },
    async makeStale(fence: Fence) {
      return guard.claim(fence.transferId);
    },
    async countAttempts(transferId: string) {
      const rows = store.rows.filter((row) => row.transferId === transferId);
      return { attempts: rows.length, hashes: new Set(rows.map((row) => row.txHash)).size };
    },
    failNextStep: (transferId: string) => gateway.failNext(transferId),
    loseNextBroadcastResponse: (transferId: string) => gateway.loseNext(transferId),
    scriptRevert: (transferId: string) => gateway.scriptRevert(transferId),
    maxSteps: 10,
  };
});
