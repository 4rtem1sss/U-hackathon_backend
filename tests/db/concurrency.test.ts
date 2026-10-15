import { afterAll, beforeAll, expect, it } from "vitest";
import { StaleFenceError } from "@/db/errors";
import { appendTransferEvent, listTransferEvents } from "@/db/repos/events";
import { completeIdempotencyKey, getIdempotencyKey, reserveIdempotencyKey } from "@/db/repos/idempotency";
import {
  assertFence,
  claimTransfer,
  getTransferForUpdate,
  releaseTransfer,
  updateTransferWithVersion,
} from "@/db/repos/transfers";
import { withTransaction } from "@/db/tx";
import { newId } from "@/lib/ids";
import { createMigratedDb, describeDb, newOwner, seedQuote, seedTransfer, type TestDb } from "./helpers";

describeDb("concurrency guards", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createMigratedDb();
  });
  afterAll(async () => {
    await db?.drop();
  });

  it("idempotency reserve: 10 concurrent same-key calls insert exactly once", async () => {
    const owner = newOwner();
    const key = newId("idem");
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        withTransaction(
          async (c) => {
            const r = await reserveIdempotencyKey(c, owner, "CREATE_TRANSFER", key, "fp-1");
            // Keep the transaction open briefly so the others queue on the key.
            await c.query("SELECT pg_sleep(0.05)");
            return r;
          },
          { pool: db.pool },
        ),
      ),
    );
    expect(results.filter((r) => r.inserted)).toHaveLength(1);
    for (const r of results.filter((x) => !x.inserted)) {
      expect(r).toMatchObject({ inserted: false, fingerprintMatches: true });
    }

    const other = await withTransaction(
      (c) => reserveIdempotencyKey(c, owner, "CREATE_TRANSFER", key, "fp-2"),
      { pool: db.pool },
    );
    expect(other).toMatchObject({ inserted: false, fingerprintMatches: false });

    // Same key under another scope or owner is independent.
    const t = await seedTransfer(db.pool, await seedQuote(db.pool, owner));
    const funding = await withTransaction(
      (c) => reserveIdempotencyKey(c, owner, "FUNDING", key, "fp-1", t.id),
      { pool: db.pool },
    );
    expect(funding.inserted).toBe(true);
    const otherOwner = await withTransaction(
      (c) => reserveIdempotencyKey(c, newOwner(), "CREATE_TRANSFER", key, "fp-1"),
      { pool: db.pool },
    );
    expect(otherOwner.inserted).toBe(true);

    await withTransaction(
      (c) => completeIdempotencyKey(c, owner, "CREATE_TRANSFER", key, { transferId: t.id, responseStatus: 201 }),
      { pool: db.pool },
    );
    expect(await getIdempotencyKey(db.pool, owner, "CREATE_TRANSFER", key)).toMatchObject({
      transferId: t.id,
      responseStatus: 201,
    });
  });

  it("a rolled-back reservation does not block the next request", async () => {
    const owner = newOwner();
    const key = newId("idem");
    await expect(
      withTransaction(
        async (c) => {
          await reserveIdempotencyKey(c, owner, "CREATE_TRANSFER", key, "fp");
          throw new Error("boom");
        },
        { pool: db.pool },
      ),
    ).rejects.toThrow("boom");
    const r = await withTransaction(
      (c) => reserveIdempotencyKey(c, owner, "CREATE_TRANSFER", key, "fp"),
      { pool: db.pool },
    );
    expect(r.inserted).toBe(true);
  });

  it("claim: exactly one of 10 concurrent claims wins; release allows the next epoch", async () => {
    const t = await seedTransfer(db.pool, await seedQuote(db.pool, newOwner()));
    const epochs = await Promise.all(Array.from({ length: 10 }, () => claimTransfer(t.id, 20, db.pool)));
    const winners = epochs.filter((e): e is number => e !== null);
    expect(winners).toEqual([1]);

    expect(await claimTransfer(t.id, 20, db.pool)).toBeNull();
    expect(await releaseTransfer(t.id, 99, db.pool)).toBe(false);
    expect(await releaseTransfer(t.id, 1, db.pool)).toBe(true);
    expect(await claimTransfer(t.id, 20, db.pool)).toBe(2);
    expect(await claimTransfer(newId("tr"), 20, db.pool)).toBeNull();
  });

  it("claim: an expired lease can be taken over", async () => {
    const t = await seedTransfer(db.pool, await seedQuote(db.pool, newOwner()));
    expect(await claimTransfer(t.id, 20, db.pool)).toBe(1);
    await db.pool.query("UPDATE transfers SET claim_expires_at = now() - interval '1 second' WHERE id = $1", [t.id]);
    expect(await claimTransfer(t.id, 20, db.pool)).toBe(2);
  });

  it("assertFence: current epoch passes, stale epoch throws StaleFenceError", async () => {
    const t = await seedTransfer(db.pool, await seedQuote(db.pool, newOwner()));
    const e1 = await claimTransfer(t.id, 20, db.pool);
    expect(e1).toBe(1);
    await withTransaction((c) => assertFence(c, { transferId: t.id, epoch: 1 }), { pool: db.pool });

    // Lease expires; another caller takes over with epoch 2.
    await db.pool.query("UPDATE transfers SET claim_expires_at = now() - interval '1 second' WHERE id = $1", [t.id]);
    expect(await claimTransfer(t.id, 20, db.pool)).toBe(2);

    const stale = withTransaction((c) => assertFence(c, { transferId: t.id, epoch: 1 }), { pool: db.pool });
    await expect(stale).rejects.toBeInstanceOf(StaleFenceError);
    await expect(stale).rejects.toMatchObject({ transferId: t.id, expectedEpoch: 1, actualEpoch: 2 });

    await expect(
      withTransaction((c) => assertFence(c, { transferId: newId("tr"), epoch: 1 }), { pool: db.pool }),
    ).rejects.toMatchObject({ name: "StaleFenceError", actualEpoch: null });

    // A stale holder's version-checked update with its epoch also writes nothing.
    const row = await withTransaction((c) => getTransferForUpdate(c, t.id), { pool: db.pool });
    expect(
      await updateTransferWithVersion(db.pool, t.id, row!.version, { status: "FUNDED_SIMULATED" }, { expectedEpoch: 1 }),
    ).toBeNull();
  });

  it("assertFence holds the row lock until the fenced transaction ends", async () => {
    const t = await seedTransfer(db.pool, await seedQuote(db.pool, newOwner()));
    expect(await claimTransfer(t.id, 20, db.pool)).toBe(1);
    const order: string[] = [];
    await withTransaction(
      async (c) => {
        await assertFence(c, { transferId: t.id, epoch: 1 });
        // A takeover attempt (lease forced expired) must wait for this transaction.
        const takeover = db.pool
          .query(
            `UPDATE transfers SET claim_epoch = claim_epoch + 1 WHERE id = $1 RETURNING claim_epoch`,
            [t.id],
          )
          .then(() => order.push("takeover"));
        await c.query("SELECT pg_sleep(0.1)");
        order.push("fenced-write");
        await c.query("SELECT 1");
        // Do not await the takeover here (it is blocked on our lock).
        void takeover;
      },
      { pool: db.pool },
    );
    // Wait for the takeover to finish after our commit.
    for (let i = 0; i < 50 && order.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(["fenced-write", "takeover"]);
  });

  it("updateTransferWithVersion: version check, bumps version, writes jsonb", async () => {
    const t = await seedTransfer(db.pool, await seedQuote(db.pool, newOwner()));
    const next = await withTransaction(
      async (c) => {
        const cur = await getTransferForUpdate(c, t.id);
        const updated = await updateTransferWithVersion(c, t.id, cur!.version, {
          status: "FUNDED_SIMULATED",
          fundingStatus: "ACCEPTED",
          fundingReference: "fnd_ref",
          lastIssue: { code: "RPC_TIMEOUT", message: "later", retryable: true },
        });
        await appendTransferEvent(c, { transferId: t.id, fromStatus: "FUNDING_PENDING", toStatus: "FUNDED_SIMULATED" });
        return updated;
      },
      { pool: db.pool },
    );
    expect(next).toMatchObject({
      version: 2,
      status: "FUNDED_SIMULATED",
      fundingStatus: "ACCEPTED",
      fundingReference: "fnd_ref",
      lastIssue: { code: "RPC_TIMEOUT", message: "later", retryable: true },
    });
    expect(next!.updatedAt.getTime()).toBeGreaterThanOrEqual(t.updatedAt.getTime());

    // Stale version: no change.
    expect(await updateTransferWithVersion(db.pool, t.id, 1, { status: "SETTLED" })).toBeNull();
    // Clearing a jsonb column with null works.
    const cleared = await updateTransferWithVersion(db.pool, t.id, 2, { lastIssue: null });
    expect(cleared).toMatchObject({ version: 3, lastIssue: null });
    expect(await listTransferEvents(db.pool, t.id)).toHaveLength(1);
  });

  it("concurrent version-checked updates: exactly one wins", async () => {
    const t = await seedTransfer(db.pool, await seedQuote(db.pool, newOwner()));
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        updateTransferWithVersion(db.pool, t.id, 1, { status: "FUNDED_SIMULATED" }),
      ),
    );
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });
});
