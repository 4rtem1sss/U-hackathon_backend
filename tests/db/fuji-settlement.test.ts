import type pg from "pg";
import { afterEach, beforeEach, expect, it } from "vitest";
import { assertFence as assertDbFence, claimTransfer } from "@/db/repos/transfers";
import { isStaleFenceError as isDbStaleFenceError } from "@/db/errors";
import { withTransaction } from "@/db/tx";
import { StaleFenceError, type Fence, type FenceGuard } from "@/settlement/contract";
import { buildSettlementIntent } from "@/settlement/intent";
import {
  FujiSettlementModule,
  PgFujiAttemptStore,
  type FujiAttemptRecord,
  type FujiGateway,
} from "@/settlement/fuji";
import { createMigratedDb, describeDb, newOwner, seedQuote, seedTransfer, type TestDb } from "./helpers";

const TOKEN = "0x5425890298aed601595a70AB815c96711a31Bc65";
const DESTINATION = "0x000000000000000000000000000000000000dEaD";
const SIGNER = "0x1111111111111111111111111111111111111111";
const TX_HASH = `0x${"a".repeat(64)}` as const;
const SIGNED_TX = `0x02${"ab".repeat(80)}` as const;

class DbMockGateway implements FujiGateway {
  readonly signerAddress = SIGNER;

  async prepare() {
    return { signer: SIGNER, nonce: "7", signedTx: SIGNED_TX, txHash: TX_HASH };
  }

  async broadcast() {
    return TX_HASH;
  }

  async inspect(attempt: FujiAttemptRecord) {
    return {
      kind: "CONFIRMED" as const,
      evidence: {
        chainId: 43113,
        blockNumber: "100",
        blockHash: `0x${"b".repeat(64)}`,
        tokenAddress: attempt.tokenAddress,
        from: attempt.signer,
        to: attempt.destination,
        units: attempt.units,
        confirmations: 2,
        verifiedAt: new Date().toISOString(),
      },
    };
  }

  async preflight() {
    return { ok: true, issues: [] };
  }
}

describeDb("Fuji settlement PostgreSQL integration", () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await createMigratedDb();
  });

  afterEach(async () => {
    await db.drop();
  });

  function fenceGuard(): FenceGuard<pg.PoolClient> {
    const check = async (fence: Fence, client: pg.PoolClient) => {
      try {
        await assertDbFence(client, fence);
      } catch (error) {
        if (isDbStaleFenceError(error)) throw new StaleFenceError(fence, error.actualEpoch);
        throw error;
      }
    };
    return {
      async assertFence(fence, tx) {
        if (tx) return check(fence, tx);
        return withTransaction((client) => check(fence, client), { pool: db.pool });
      },
    };
  }

  it("persists signed bytes before broadcast and never updates transfers", async () => {
    const quote = await seedQuote(db.pool, newOwner());
    const transfer = await seedTransfer(db.pool, quote);
    const epoch = await claimTransfer(transfer.id, 30, db.pool);
    expect(epoch).not.toBeNull();
    const fence = { transferId: transfer.id, epoch: epoch! };
    const intent = buildSettlementIntent(
      { id: transfer.id, settlementTokenUnits: BigInt(transfer.settlementTokenUnits) },
      { AVALANCHE_CHAIN_ID: 43113, USDC_TOKEN_ADDRESS: TOKEN, DESTINATION_SETTLEMENT_ADDRESS: DESTINATION },
    );
    const settlement = new FujiSettlementModule({
      fenceGuard: fenceGuard(),
      store: new PgFujiAttemptStore(() => db.pool),
      gateway: new DbMockGateway(),
      tokenAddress: TOKEN,
      destination: DESTINATION,
    });

    const before = await db.pool.query("SELECT * FROM transfers WHERE id = $1", [transfer.id]);
    const prepared = await settlement.step(intent, fence);
    expect(prepared).toMatchObject({ kind: "NOT_SUBMITTED", attemptId: expect.stringMatching(/^stl_/) });

    const stored = await db.pool.query(
      "SELECT nonce, signed_tx, tx_hash, phase, created_fence FROM settlement_attempts WHERE transfer_id = $1",
      [transfer.id],
    );
    expect(stored.rows).toEqual([
      expect.objectContaining({ nonce: "7", signed_tx: SIGNED_TX, tx_hash: TX_HASH, phase: "PREPARED", created_fence: epoch }),
    ]);
    const after = await db.pool.query("SELECT * FROM transfers WHERE id = $1", [transfer.id]);
    expect(after.rows).toEqual(before.rows);

    const broadcast = await settlement.step(intent, fence);
    expect(broadcast).toMatchObject({ kind: "PENDING", phase: "BROADCAST", txHash: TX_HASH });
  });
});
