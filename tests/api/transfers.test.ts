import { expect, it } from "vitest";
import { describeDb, newKey, readJson, seedSession, seedSessionWithQuote, useApiTestDb, type TestSession } from "../server/helpers";
import { body, create, fund, get } from "./client";

describeDb("POST /api/transfers, GET /api/transfers/[id]", () => {
  const t = useApiTestDb();

  const transferCount = async (quoteId: string) =>
    Number((await t.db.pool.query("SELECT count(*)::int AS n FROM transfers WHERE quote_id = $1", [quoteId])).rows[0].n);

  it("creates a FUNDING_PENDING transfer (201, version 1, SIMULATE_FUNDING)", async () => {
    const { session, quote } = await seedSessionWithQuote(t.db.pool);
    const res = await create(session, newKey(), body(quote));
    expect(res.status).toBe(201);
    const json = await readJson(res);
    expect(json.meta).toMatchObject({ apiVersion: "v1", replayed: false });
    const d = json.data;
    expect(d).toMatchObject({
      quoteId: quote.id,
      status: "FUNDING_PENDING",
      version: 1,
      mode: "DEMO",
      purpose: "PERSONAL_REMITTANCE",
      demoScenario: "HAPPY_PATH",
      nextAction: "SIMULATE_FUNDING",
      lastIssue: null,
      receipt: null,
      amounts: {
        sourceCurrency: "USD",
        destinationCurrency: "THB",
        sourceDebitMinor: "1000",
        feeMinor: "20",
        conversionPrincipalMinor: "980",
        destinationNetMinor: "34300",
        settlementTokenUnits: "9800000",
      },
      funding: { mode: "SIMULATED", status: "PENDING", reference: null },
      fx: { mode: "SIMULATED", fixtureVersion: "fixture-us-th-v1", rateNumerator: "35", rateDenominator: "1" },
      settlement: {
        mode: "TESTNET",
        status: "NOT_STARTED",
        chainId: 43113,
        tokenSymbol: "USDC",
        tokenAddress: "0x5425890298aed601595a70AB815c96711a31Bc65",
        tokenDecimals: 6,
        txHash: null,
        explorerUrl: null,
        verifiedAt: null,
      },
      payout: { mode: "SIMULATED", status: "NOT_STARTED", reference: null },
    });
    expect(d.events).toEqual([{ sequence: 1, status: "FUNDING_PENDING", createdAt: d.createdAt }]);
    expect(d).not.toHaveProperty("ownerId");
    const q = await t.db.pool.query("SELECT status FROM quotes WHERE id = $1", [quote.id]);
    expect(q.rows[0].status).toBe("ACCEPTED");
  });

  it("same key + same payload replays (200, replayed) with one transfer", async () => {
    const { session, quote } = await seedSessionWithQuote(t.db.pool);
    const key = newKey();
    const first = await readJson(await create(session, key, body(quote)));
    const res = await create(session, key, body(quote));
    expect(res.status).toBe(200);
    const json = await readJson(res);
    expect(json.meta.replayed).toBe(true);
    expect(json.data.id).toBe(first.data.id);
    expect(await transferCount(quote.id)).toBe(1);
  });

  it("10 concurrent same-key requests create exactly one transfer", async () => {
    const { session, quote } = await seedSessionWithQuote(t.db.pool);
    const key = newKey();
    const responses = await Promise.all(Array.from({ length: 10 }, () => create(session, key, body(quote))));
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 200)).toHaveLength(9);
    const ids = new Set(await Promise.all(responses.map(async (r) => (await readJson(r)).data.id)));
    expect(ids.size).toBe(1);
    expect(await transferCount(quote.id)).toBe(1);
  });

  it("same key + different payload -> 409 IDEMPOTENCY_CONFLICT", async () => {
    const { session, quote } = await seedSessionWithQuote(t.db.pool);
    const key = newKey();
    expect((await create(session, key, body(quote))).status).toBe(201);
    const res = await create(session, key, body(quote, "PAYOUT_FAILED"));
    expect(res.status).toBe(409);
    expect((await readJson(res)).error?.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(await transferCount(quote.id)).toBe(1);
  });

  it("different key on an accepted quote -> 409 QUOTE_ALREADY_ACCEPTED", async () => {
    const { session, quote } = await seedSessionWithQuote(t.db.pool);
    expect((await create(session, newKey(), body(quote))).status).toBe(201);
    const res = await create(session, newKey(), body(quote));
    expect(res.status).toBe(409);
    expect((await readJson(res)).error?.code).toBe("QUOTE_ALREADY_ACCEPTED");
    expect(await transferCount(quote.id)).toBe(1);
  });

  it("concurrent different keys on one quote -> one 201, rest QUOTE_ALREADY_ACCEPTED", async () => {
    const { session, quote } = await seedSessionWithQuote(t.db.pool);
    const responses = await Promise.all(Array.from({ length: 5 }, () => create(session, newKey(), body(quote))));
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409, 409, 409]);
    expect(await transferCount(quote.id)).toBe(1);
  });

  it("expired quote -> 410 QUOTE_EXPIRED, no transfer, key not kept", async () => {
    const { session, quote } = await seedSessionWithQuote(t.db.pool, { quoteExpiresInSeconds: -5 });
    const key = newKey();
    const res = await create(session, key, body(quote));
    expect(res.status).toBe(410);
    expect((await readJson(res)).error?.code).toBe("QUOTE_EXPIRED");
    expect(await transferCount(quote.id)).toBe(0);
    const keys = await t.db.pool.query("SELECT 1 FROM idempotency_keys WHERE owner_id = $1 AND key = $2", [
      session.ownerId,
      key,
    ]);
    expect(keys.rowCount).toBe(0);
    const q = await t.db.pool.query("SELECT status FROM quotes WHERE id = $1", [quote.id]);
    expect(q.rows[0].status).toBe("OPEN");
  });

  it("replay after the quote expired returns the original transfer", async () => {
    const { session, quote } = await seedSessionWithQuote(t.db.pool);
    const key = newKey();
    const first = await readJson(await create(session, key, body(quote)));
    await t.db.pool.query("UPDATE quotes SET expires_at = now() - interval '1 minute' WHERE id = $1", [quote.id]);
    const res = await create(session, key, body(quote));
    expect(res.status).toBe(200);
    const json = await readJson(res);
    expect(json.meta.replayed).toBe(true);
    expect(json.data.id).toBe(first.data.id);
  });

  it("another owner gets 404 on GET and cannot replay the key", async () => {
    const { session, quote } = await seedSessionWithQuote(t.db.pool);
    const key = newKey();
    const first = await readJson(await create(session, key, body(quote)));
    const other = await seedSession(t.db.pool);

    const g = await get(other, first.data.id);
    expect(g.status).toBe(404);
    expect((await readJson(g)).error?.code).toBe("NOT_FOUND");

    const replay = await create(other, key, body(quote));
    expect(replay.status).toBe(404);
    expect((await readJson(replay)).error?.code).toBe("NOT_FOUND");

    const f = await fund(other, first.data.id, newKey());
    expect(f.status).toBe(404);
    expect(await transferCount(quote.id)).toBe(1);
  });

  it("missing or malformed Idempotency-Key -> 400 IDEMPOTENCY_KEY_REQUIRED", async () => {
    const { session, quote } = await seedSessionWithQuote(t.db.pool);
    for (const key of [null, "not-a-uuid"]) {
      const res = await create(session, key, body(quote));
      expect(res.status).toBe(400);
      expect((await readJson(res)).error?.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    }
    expect(await transferCount(quote.id)).toBe(0);
  });

  it("extra or invalid fields -> 400 INVALID_INPUT", async () => {
    const { session, quote } = await seedSessionWithQuote(t.db.pool);
    const extra = await create(session, newKey(), { ...body(quote), feeMinor: "0" });
    expect(extra.status).toBe(400);
    expect((await readJson(extra)).error?.code).toBe("INVALID_INPUT");
    const bad = await create(session, newKey(), body(quote, "FORCE_SUCCESS"));
    expect(bad.status).toBe(400);
    expect((await readJson(bad)).error?.fieldErrors).toHaveProperty("demoScenario");
    expect(await transferCount(quote.id)).toBe(0);
  });

  it("unknown quote -> 404", async () => {
    const session = await seedSession(t.db.pool);
    const res = await create(session, newKey(), { quoteId: "qt_missing", purpose: "PERSONAL_REMITTANCE", demoScenario: "HAPPY_PATH" });
    expect(res.status).toBe(404);
  });

  it("bad or missing origin -> 403 ORIGIN_NOT_ALLOWED", async () => {
    const { session, quote } = await seedSessionWithQuote(t.db.pool);
    for (const origin of ["https://evil.example", null]) {
      const res = await create(session, newKey(), body(quote), origin);
      expect(res.status).toBe(403);
      expect((await readJson(res)).error?.code).toBe("ORIGIN_NOT_ALLOWED");
    }
    expect(await transferCount(quote.id)).toBe(0);
  });

  it("no, unknown or expired session -> 401 UNAUTHENTICATED", async () => {
    const { quote } = await seedSessionWithQuote(t.db.pool);
    const expired = await seedSession(t.db.pool, { expiresInSeconds: -1 });
    const sessions: TestSession[] = [
      { ...expired, cookie: "" },
      { ...expired, cookie: "demo_session=unknown-token" },
      expired,
    ];
    for (const s of sessions) {
      const res = await create(s, newKey(), body(quote));
      expect(res.status).toBe(401);
      expect((await readJson(res)).error?.code).toBe("UNAUTHENTICATED");
    }
  });

  it("GET returns the snapshot and performs no writes", async () => {
    const { session, quote } = await seedSessionWithQuote(t.db.pool);
    const created = await readJson(await create(session, newKey(), body(quote)));
    const id = created.data.id as string;
    const before = await t.db.pool.query("SELECT version, updated_at, claim_epoch FROM transfers WHERE id = $1", [id]);
    const g1 = await get(session, id);
    const g2 = await get(session, id);
    expect(g1.status).toBe(200);
    const s1 = await readJson(g1);
    const s2 = await readJson(g2);
    expect(s1.data).toEqual(created.data);
    expect(s2.data).toEqual(created.data);
    expect(s1.meta.replayed).toBe(false);
    const after = await t.db.pool.query("SELECT version, updated_at, claim_epoch FROM transfers WHERE id = $1", [id]);
    expect(after.rows[0]).toEqual(before.rows[0]);
    const events = await t.db.pool.query("SELECT count(*)::int AS n FROM transfer_events WHERE transfer_id = $1", [id]);
    expect(events.rows[0].n).toBe(1);
  });

  it("GET of an unknown id -> 404", async () => {
    const session = await seedSession(t.db.pool);
    expect((await get(session, "tr_missing")).status).toBe(404);
  });
});
