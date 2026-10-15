import { expect, it } from "vitest";
import { seedQuote } from "../db/helpers";
import { describeDb, newKey, readJson, seedSessionWithQuote, useApiTestDb } from "../server/helpers";
import { body, create, fund, get } from "./client";

describeDb("POST /api/demo/transfers/[id]/funding", () => {
  const t = useApiTestDb();

  it("funding (HAPPY_PATH) -> FUNDED_SIMULATED, version 2, nextAction ADVANCE", async () => {
    const { session, quote } = await seedSessionWithQuote(t.db.pool);
    const id = (await readJson(await create(session, newKey(), body(quote)))).data.id as string;
    const res = await fund(session, id, newKey());
    expect(res.status).toBe(200);
    const json = await readJson(res);
    expect(json.meta.replayed).toBe(false);
    expect(json.data).toMatchObject({
      status: "FUNDED_SIMULATED",
      version: 2,
      nextAction: "ADVANCE",
      funding: { mode: "SIMULATED", status: "ACCEPTED", reference: `funding_sim_${id}` },
      settlement: { status: "NOT_STARTED", txHash: null },
      payout: { status: "NOT_STARTED", reference: null },
      lastIssue: null,
      receipt: null,
    });
    expect(json.data.events.map((e: { sequence: number; status: string }) => [e.sequence, e.status])).toEqual([
      [1, "FUNDING_PENDING"],
      [2, "FUNDED_SIMULATED"],
    ]);
    const attempts = await t.db.pool.query("SELECT status FROM funding_attempts WHERE transfer_id = $1", [id]);
    expect(attempts.rows).toEqual([{ status: "ACCEPTED" }]);
    // GET agrees with the mutation response.
    expect((await readJson(await get(session, id))).data).toEqual(json.data);
  });

  it("PAYOUT_FAILED scenario still funds successfully", async () => {
    const { session, quote } = await seedSessionWithQuote(t.db.pool);
    const id = (await readJson(await create(session, newKey(), body(quote, "PAYOUT_FAILED")))).data.id as string;
    expect((await readJson(await fund(session, id, newKey()))).data.status).toBe("FUNDED_SIMULATED");
  });

  it("FUNDING_DECLINED -> FUNDING_FAILED, nextAction NONE", async () => {
    const { session, quote } = await seedSessionWithQuote(t.db.pool);
    const id = (await readJson(await create(session, newKey(), body(quote, "FUNDING_DECLINED")))).data.id as string;
    const res = await fund(session, id, newKey());
    expect(res.status).toBe(200);
    const d = (await readJson(res)).data;
    expect(d).toMatchObject({
      status: "FUNDING_FAILED",
      version: 2,
      nextAction: "NONE",
      funding: { status: "DECLINED", reference: `funding_sim_${id}` },
      lastIssue: { code: "FUNDING_DECLINED", retryable: false },
    });
  });

  it("funding replay with the same key -> 200 replayed, one attempt", async () => {
    const { session, quote } = await seedSessionWithQuote(t.db.pool);
    const id = (await readJson(await create(session, newKey(), body(quote)))).data.id as string;
    const key = newKey();
    const first = await readJson(await fund(session, id, key));
    const res = await fund(session, id, key);
    expect(res.status).toBe(200);
    const json = await readJson(res);
    expect(json.meta.replayed).toBe(true);
    expect(json.data).toEqual(first.data);
    const n = await t.db.pool.query("SELECT count(*)::int AS n FROM funding_attempts WHERE transfer_id = $1", [id]);
    expect(n.rows[0].n).toBe(1);
  });

  it("concurrent same-key funding -> one attempt, one non-replayed response", async () => {
    const { session, quote } = await seedSessionWithQuote(t.db.pool);
    const id = (await readJson(await create(session, newKey(), body(quote)))).data.id as string;
    const key = newKey();
    const responses = await Promise.all(Array.from({ length: 6 }, () => fund(session, id, key)));
    expect(responses.every((r) => r.status === 200)).toBe(true);
    const metas = await Promise.all(responses.map(async (r) => (await readJson(r)).meta.replayed));
    expect(metas.filter((m) => m === false)).toHaveLength(1);
    const n = await t.db.pool.query("SELECT count(*)::int AS n FROM funding_attempts WHERE transfer_id = $1", [id]);
    expect(n.rows[0].n).toBe(1);
  });

  it("funding with a new key after funding -> 409 INVALID_STATE", async () => {
    const { session, quote } = await seedSessionWithQuote(t.db.pool);
    const id = (await readJson(await create(session, newKey(), body(quote)))).data.id as string;
    expect((await fund(session, id, newKey())).status).toBe(200);
    const key2 = newKey();
    const res = await fund(session, id, key2);
    expect(res.status).toBe(409);
    expect((await readJson(res)).error?.code).toBe("INVALID_STATE");
    const k = await t.db.pool.query("SELECT 1 FROM idempotency_keys WHERE key = $1", [key2]);
    expect(k.rowCount).toBe(0);
  });

  it("funding key reused on another transfer -> 409 IDEMPOTENCY_CONFLICT", async () => {
    const { session, quote } = await seedSessionWithQuote(t.db.pool);
    const quote2 = await seedQuote(t.db.pool, session.ownerId);
    const id1 = (await readJson(await create(session, newKey(), body(quote)))).data.id as string;
    const id2 = (await readJson(await create(session, newKey(), body(quote2)))).data.id as string;
    const key = newKey();
    expect((await fund(session, id1, key)).status).toBe(200);
    const res = await fund(session, id2, key);
    expect(res.status).toBe(409);
    expect((await readJson(res)).error?.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("funding: missing key 400, extra body field 400", async () => {
    const { session, quote } = await seedSessionWithQuote(t.db.pool);
    const id = (await readJson(await create(session, newKey(), body(quote)))).data.id as string;
    const noKey = await fund(session, id, null);
    expect(noKey.status).toBe(400);
    expect((await readJson(noKey)).error?.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    const extra = await fund(session, id, newKey(), { status: "FUNDED_SIMULATED" });
    expect(extra.status).toBe(400);
    expect((await readJson(extra)).error?.code).toBe("INVALID_INPUT");
    expect((await readJson(await get(session, id))).data.status).toBe("FUNDING_PENDING");
  });

  it("funding: bad origin -> 403", async () => {
    const { session, quote } = await seedSessionWithQuote(t.db.pool);
    const id = (await readJson(await create(session, newKey(), body(quote)))).data.id as string;
    const res = await fund(session, id, newKey(), {}, "https://evil.example");
    expect(res.status).toBe(403);
  });
});
