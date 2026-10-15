import { afterAll, beforeAll, expect, it } from "vitest";
import { CONSTRAINTS, isUniqueViolation } from "@/db/errors";
import { appendTransferEvent, listTransferEvents } from "@/db/repos/events";
import { insertFundingAttempt } from "@/db/repos/fundingAttempts";
import {
  getLatestPayoutAttempt,
  insertPayoutAttempt,
  updatePayoutAttemptStatus,
} from "@/db/repos/payoutAttempts";
import { getQuoteForUpdate, markQuoteAccepted } from "@/db/repos/quotes";
import { latestSettlementAttemptForTransfer } from "@/db/repos/settlementAttempts";
import { getTransferForOwner } from "@/db/repos/transfers";
import { withTransaction } from "@/db/tx";
import { newId } from "@/lib/ids";
import { createMigratedDb, describeDb, newOwner, seedQuote, seedTransfer, type TestDb } from "./helpers";

async function pgError(p: Promise<unknown>): Promise<{ code?: string; constraint?: string }> {
  try {
    await p;
  } catch (err) {
    return err as { code?: string; constraint?: string };
  }
  throw new Error("expected the query to fail");
}

describeDb("schema constraints", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createMigratedDb();
  });
  afterAll(async () => {
    await db?.drop();
  });

  it("returns amounts as strings and enforces unique(quote_id)", async () => {
    const owner = newOwner();
    const quote = await seedQuote(db.pool, owner);
    const t = await seedTransfer(db.pool, quote);
    expect(t.status).toBe("FUNDING_PENDING");
    expect(t.version).toBe(1);
    expect(t.claimEpoch).toBe(0);
    expect(t.sourceDebitMinor).toBe("1000");
    expect(t.settlementTokenUnits).toBe("9800000");
    expect(t.fundingStatus).toBe("PENDING");
    expect(t.settlementStatus).toBe("NOT_STARTED");
    expect(t.payoutStatus).toBe("NOT_STARTED");
    expect(t.recipientSnapshot.name).toBe("Demo Recipient");

    const err = await pgError(seedTransfer(db.pool, quote));
    expect(isUniqueViolation(err, CONSTRAINTS.transfersQuoteId)).toBe(true);

    expect(await getTransferForOwner(db.pool, owner, t.id)).toMatchObject({ id: t.id });
    expect(await getTransferForOwner(db.pool, newOwner(), t.id)).toBeNull();
  });

  it("rejects values outside the check constraints", async () => {
    const quote = await seedQuote(db.pool, newOwner());
    const t = await seedTransfer(db.pool, quote);
    const err = await pgError(db.pool.query("UPDATE transfers SET status = 'DONE' WHERE id = $1", [t.id]));
    expect(err.code).toBe("23514");
    const err2 = await pgError(
      db.pool.query("UPDATE transfers SET payout_status = 'PAID_REAL' WHERE id = $1", [t.id]),
    );
    expect(err2.code).toBe("23514");
  });

  it("quote acceptance: OPEN -> ACCEPTED once; expired quotes are refused", async () => {
    const owner = newOwner();
    const quote = await seedQuote(db.pool, owner);
    await withTransaction(
      async (c) => {
        expect(await getQuoteForUpdate(c, newOwner(), quote.id)).toBeNull();
        expect((await getQuoteForUpdate(c, owner, quote.id))?.status).toBe("OPEN");
        const accepted = await markQuoteAccepted(c, quote.id);
        expect(accepted?.status).toBe("ACCEPTED");
        expect(accepted?.acceptedAt).toBeInstanceOf(Date);
        expect(await markQuoteAccepted(c, quote.id)).toBeNull();
      },
      { pool: db.pool },
    );
    const expired = await seedQuote(db.pool, owner, { expiresInSeconds: -1 });
    await withTransaction(async (c) => expect(await markQuoteAccepted(c, expired.id)).toBeNull(), {
      pool: db.pool,
    });
  });

  it("transfer_events are sequenced and cannot be updated or deleted", async () => {
    const quote = await seedQuote(db.pool, newOwner());
    const t = await seedTransfer(db.pool, quote);
    await withTransaction(
      async (c) => {
        const e1 = await appendTransferEvent(c, { transferId: t.id, fromStatus: null, toStatus: "FUNDING_PENDING" });
        const e2 = await appendTransferEvent(c, {
          transferId: t.id,
          fromStatus: "FUNDING_PENDING",
          toStatus: "FUNDED_SIMULATED",
          attemptRef: "fnd_x",
        });
        expect([e1.sequence, e2.sequence]).toEqual([1, 2]);
        expect(typeof e1.id).toBe("string");
      },
      { pool: db.pool },
    );
    expect((await listTransferEvents(db.pool, t.id)).map((e) => e.toStatus)).toEqual([
      "FUNDING_PENDING",
      "FUNDED_SIMULATED",
    ]);

    const upd = await pgError(
      db.pool.query("UPDATE transfer_events SET reason = 'x' WHERE transfer_id = $1", [t.id]),
    );
    expect(upd.code).toBe("23001");
    const del = await pgError(db.pool.query("DELETE FROM transfer_events WHERE transfer_id = $1", [t.id]));
    expect(del.code).toBe("23001");
    const trunc = await pgError(db.pool.query("TRUNCATE transfer_events"));
    expect(trunc.code).toBe("23001");
    expect(await listTransferEvents(db.pool, t.id)).toHaveLength(2);

    const dup = await pgError(
      db.pool.query(
        "INSERT INTO transfer_events (transfer_id, sequence, to_status) VALUES ($1, 1, 'SETTLED')",
        [t.id],
      ),
    );
    expect(isUniqueViolation(dup, CONSTRAINTS.transferEventsSequence)).toBe(true);
  });

  it("allows only one funding attempt per transfer", async () => {
    const t = await seedTransfer(db.pool, await seedQuote(db.pool, newOwner()));
    await withTransaction(
      (c) =>
        insertFundingAttempt(c, { id: newId("fnd"), transferId: t.id, requestId: "r1", status: "ACCEPTED", reference: "f1" }),
      { pool: db.pool },
    );
    const err = await pgError(
      withTransaction(
        (c) =>
          insertFundingAttempt(c, { id: newId("fnd"), transferId: t.id, requestId: "r2", status: "DECLINED", reference: "f2" }),
        { pool: db.pool },
      ),
    );
    expect(isUniqueViolation(err, CONSTRAINTS.fundingAttemptsTransferId)).toBe(true);
  });

  it("numbers payout attempts and keeps request IDs unique", async () => {
    const t = await seedTransfer(db.pool, await seedQuote(db.pool, newOwner()));
    const a1 = await withTransaction(
      (c) => insertPayoutAttempt(c, { id: newId("pay"), transferId: t.id, requestId: `req-${t.id}-1` }),
      { pool: db.pool },
    );
    expect(a1).toMatchObject({ attemptNo: 1, status: "PENDING", reference: null });
    await updatePayoutAttemptStatus(db.pool, a1.id, "FAILED", "payout_ref_1");
    const a2 = await withTransaction(
      (c) => insertPayoutAttempt(c, { id: newId("pay"), transferId: t.id, requestId: `req-${t.id}-2` }),
      { pool: db.pool },
    );
    expect(a2.attemptNo).toBe(2);
    expect((await getLatestPayoutAttempt(db.pool, t.id))?.id).toBe(a2.id);

    const err = await pgError(
      withTransaction(
        (c) => insertPayoutAttempt(c, { id: newId("pay"), transferId: t.id, requestId: `req-${t.id}-2` }),
        { pool: db.pool },
      ),
    );
    expect(isUniqueViolation(err, CONSTRAINTS.payoutAttemptsRequestId)).toBe(true);
  });

  it("settlement_attempts: one unresolved attempt per signer, unique nonce and tx hash", async () => {
    const t1 = await seedTransfer(db.pool, await seedQuote(db.pool, newOwner()));
    const t2 = await seedTransfer(db.pool, await seedQuote(db.pool, newOwner()));
    const signer = "0x1111111111111111111111111111111111111111";
    const insert = (transferId: string, nonce: number, phase: string, txHash: string | null) =>
      db.pool.query(
        `INSERT INTO settlement_attempts
           (id, transfer_id, chain_id, token_address, signer, destination, units, nonce,
            signed_tx, tx_hash, phase, created_fence)
         VALUES ($1, $2, 43113, '0x5425890298aed601595a70AB815c96711a31Bc65', $3,
                 '0x000000000000000000000000000000000000dEaD', 9800000, $4, '0xsigned', $5, $6, 1)`,
        [newId("stl"), transferId, signer, nonce, txHash, phase],
      );

    await insert(t1.id, 7, "BROADCAST", "0xaaa");
    const second = await pgError(insert(t2.id, 8, "PREPARED", "0xbbb"));
    expect(isUniqueViolation(second, CONSTRAINTS.settlementOneUnresolvedPerSigner)).toBe(true);

    // Resolve the first; now a new attempt for the same signer is allowed.
    await db.pool.query("UPDATE settlement_attempts SET phase = 'CONFIRMED' WHERE tx_hash = '0xaaa'");
    const sameNonce = await pgError(insert(t2.id, 7, "PREPARED", "0xccc"));
    expect(isUniqueViolation(sameNonce, CONSTRAINTS.settlementSignerNonce)).toBe(true);
    const sameHash = await pgError(insert(t2.id, 8, "PREPARED", "0xaaa"));
    expect(isUniqueViolation(sameHash, CONSTRAINTS.settlementTxHash)).toBe(true);
    await insert(t2.id, 8, "PREPARED", "0xbbb");

    const latest = await latestSettlementAttemptForTransfer(db.pool, t1.id);
    expect(latest).toMatchObject({ phase: "CONFIRMED", nonce: "7", units: "9800000", chainId: 43113 });
    expect(await latestSettlementAttemptForTransfer(db.pool, newId("tr"))).toBeNull();
  });
});
