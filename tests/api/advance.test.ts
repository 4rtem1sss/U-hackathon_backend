import { expect, it, vi } from "vitest";
import { POST as advancePOST } from "@/app/api/demo/transfers/[id]/advance/route";
import { claimTransfer, getPool } from "@/db";
import { advanceTransfer } from "@/server/advance";
import { fakeScenario, getSettlementModule, type FakeSettlementModule } from "@/settlement";
import { dbFenceGuard } from "@/settlement/db-fence-guard";
import { createPayoutSimulator, unknownOncePerRequest } from "@/simulators/payout";
import {
  apiRequest,
  describeDb,
  idCtx,
  newKey,
  readJson,
  seedSession,
  seedSessionWithQuote,
  useApiTestDb,
  type TestSession,
} from "../server/helpers";
import { body, create, fund, get } from "./client";

const advance = (s: TestSession, id: string, payload: unknown = {}, origin?: string | null) =>
  advancePOST(
    apiRequest(`/api/demo/transfers/${id}/advance`, {
      cookie: s.cookie,
      body: payload,
      ...(origin === undefined ? {} : { origin }),
    }),
    idCtx(id),
  );

const fake = () => getSettlementModule({ fenceGuard: dbFenceGuard }) as FakeSettlementModule;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describeDb("POST /api/demo/transfers/[id]/advance", () => {
  const t = useApiTestDb();

  async function funded(scenario = "HAPPY_PATH") {
    const { session, quote } = await seedSessionWithQuote(t.db.pool);
    const id = (await readJson(await create(session, newKey(), body(quote, scenario)))).data.id as string;
    expect((await fund(session, id, newKey())).status).toBe(200);
    return { session, id };
  }

  async function step(session: TestSession, id: string) {
    const res = await advance(session, id);
    return { status: res.status, data: (await readJson(res)).data };
  }

  it("first advance: FUNDED_SIMULATED -> SETTLEMENT_PENDING and one settlement step (202)", async () => {
    const { session, id } = await funded();
    const r = await step(session, id);
    expect(r.status).toBe(202);
    expect(r.data).toMatchObject({
      status: "SETTLEMENT_PENDING",
      nextAction: "ADVANCE",
      settlement: { status: "BROADCAST" },
      payout: { status: "NOT_STARTED" },
    });
    expect(r.data.settlement.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(fake().stats(id).steps).toBe(1);
    // The claim lease is released after the call.
    const { rows } = await t.db.pool.query("SELECT claim_expires_at FROM transfers WHERE id = $1", [id]);
    expect(rows[0].claim_expires_at).toBeNull();
  });

  it("SETTLED creates exactly one payout attempt, used by PAYOUT_PENDING", async () => {
    const { session, id } = await funded();
    await step(session, id); // SETTLEMENT_PENDING / BROADCAST
    const settled = await step(session, id);
    expect(settled.data).toMatchObject({ status: "SETTLED", nextAction: "ADVANCE", settlement: { status: "CONFIRMED" } });
    const a1 = await t.db.pool.query("SELECT id, attempt_no, status FROM payout_attempts WHERE transfer_id = $1", [id]);
    expect(a1.rows).toEqual([{ id: expect.any(String), attempt_no: 1, status: "PENDING" }]);
    const pending = await step(session, id);
    expect(pending.status).toBe(202);
    expect(pending.data).toMatchObject({
      status: "PAYOUT_PENDING",
      payout: { status: "PENDING", reference: `payout_sim_${a1.rows[0].id}` },
    });
    const a2 = await t.db.pool.query("SELECT count(*)::int AS n FROM payout_attempts WHERE transfer_id = $1", [id]);
    expect(a2.rows[0].n).toBe(1);
  });

  it("throwOnce: lastIssue DEPENDENCY_UNAVAILABLE with status unchanged (202), next advance proceeds and clears it", async () => {
    const { session, id } = await funded();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = await step(session, id);
    expect(first.data.settlement.status).toBe("BROADCAST");
    fake().failNextStep(id);

    const failed = await step(session, id);
    expect(failed.status).toBe(202);
    expect(failed.data).toMatchObject({
      status: "SETTLEMENT_PENDING",
      nextAction: "ADVANCE",
      settlement: { status: "BROADCAST", txHash: first.data.settlement.txHash },
      lastIssue: { code: "DEPENDENCY_UNAVAILABLE", retryable: true },
    });
    expect(failed.data.events).toEqual(first.data.events);
    expect(warn).toHaveBeenCalled();

    // A second thrown step does not bump the version again (NO_CHANGE).
    fake().failNextStep(id);
    const failedAgain = await step(session, id);
    expect(failedAgain.data.version).toBe(failed.data.version);

    const recovered = await step(session, id);
    expect(recovered.data).toMatchObject({
      status: "SETTLED",
      lastIssue: null,
      settlement: { status: "CONFIRMED", txHash: first.data.settlement.txHash },
    });
    expect(fake().stats(id)).toMatchObject({ attemptsCreated: 1, distinctHashes: 1 });
  });

  it("lostResponse: same txHash after recovery and only one attempt", async () => {
    const { session, id } = await funded();
    fake().script(id, fakeScenario.lostResponse(fakeScenario.confirmAfter(3)));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const lost = await step(session, id);
    expect(lost.status).toBe(202);
    expect(lost.data).toMatchObject({
      status: "SETTLEMENT_PENDING",
      settlement: { status: "PREPARING", txHash: null },
      lastIssue: { code: "DEPENDENCY_UNAVAILABLE" },
    });
    const storedHash = (await fake().getAttempt(id))?.txHash;
    expect(storedHash).toMatch(/^0x/);

    const pending = await step(session, id);
    expect(pending.data).toMatchObject({ settlement: { status: "PENDING", txHash: storedHash }, lastIssue: null });
    const settled = await step(session, id);
    expect(settled.data).toMatchObject({ status: "SETTLED", settlement: { status: "CONFIRMED", txHash: storedHash } });
    expect(fake().stats(id)).toMatchObject({ attemptsCreated: 1, distinctHashes: 1, broadcasts: 1 });
  });

  it("revert -> SETTLEMENT_FAILED, nextAction NONE, hash kept, payout NOT_STARTED", async () => {
    const { session, id } = await funded();
    fake().script(id, fakeScenario.revert(2));
    const first = await step(session, id);
    const r = await step(session, id);
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({
      status: "SETTLEMENT_FAILED",
      nextAction: "NONE",
      settlement: { status: "FAILED", txHash: first.data.settlement.txHash, verifiedAt: null },
      payout: { status: "NOT_STARTED", reference: null },
      lastIssue: { code: "SETTLEMENT_REVERTED" },
    });
    const n = await t.db.pool.query("SELECT count(*)::int AS n FROM payout_attempts WHERE transfer_id = $1", [id]);
    expect(n.rows[0].n).toBe(0);
    // Terminal: further advances are 200 no-ops and do not call settlement.
    const steps = fake().stats(id).steps;
    expect((await step(session, id)).status).toBe(200);
    expect(fake().stats(id).steps).toBe(steps);
  });

  it("review -> REVIEW_REQUIRED, nextAction NONE", async () => {
    const { session, id } = await funded();
    fake().script(id, fakeScenario.review(2));
    await step(session, id);
    const r = await step(session, id);
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({
      status: "REVIEW_REQUIRED",
      nextAction: "NONE",
      settlement: { status: "REVIEW_REQUIRED" },
      payout: { status: "NOT_STARTED" },
    });
    expect(r.data.settlement.txHash).toMatch(/^0x/);
  });

  it("two concurrent advance calls: only one steps settlement at a time; final state consistent", async () => {
    const { session, id } = await funded();
    const f = fake();
    const original = f.step.bind(f);
    let inFlight = 0;
    let maxInFlight = 0;
    vi.spyOn(f, "step").mockImplementation(async (intent, fence) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await sleep(100);
        return await original(intent, fence);
      } finally {
        inFlight -= 1;
      }
    });

    const [a, b] = await Promise.all([advance(session, id), advance(session, id)]);
    expect([a.status, b.status]).toEqual([202, 202]);
    expect(maxInFlight).toBe(1);
    expect(f.step).toHaveBeenCalledTimes(1);

    // Drive the rest with concurrent pairs.
    for (let i = 0; i < 20; i++) {
      const s = (await readJson(await get(session, id))).data;
      if (s.nextAction !== "ADVANCE") break;
      await Promise.all([advance(session, id), advance(session, id)]);
    }
    expect(maxInFlight).toBe(1);
    const final = (await readJson(await get(session, id))).data;
    expect(final.status).toBe("COMPLETED_SIMULATED");
    expect(final.events.map((e: { status: string }) => e.status)).toEqual([
      "FUNDING_PENDING",
      "FUNDED_SIMULATED",
      "SETTLEMENT_PENDING",
      "SETTLED",
      "PAYOUT_PENDING",
      "COMPLETED_SIMULATED",
    ]);
    expect(f.stats(id)).toMatchObject({ attemptsCreated: 1, distinctHashes: 1 });
    const n = await t.db.pool.query("SELECT count(*)::int AS n FROM payout_attempts WHERE transfer_id = $1", [id]);
    expect(n.rows[0].n).toBe(1);
  });

  it("claim held by someone else -> 202 with the unchanged snapshot, settlement not called", async () => {
    const { session, id } = await funded();
    const before = (await readJson(await get(session, id))).data;
    expect(await claimTransfer(id, 20, getPool())).not.toBeNull();
    const spy = vi.spyOn(fake(), "step");
    const res = await advance(session, id);
    expect(res.status).toBe(202);
    expect((await readJson(res)).data).toEqual(before);
    expect(spy).not.toHaveBeenCalled();
    // The other holder's lease is not released by us.
    const { rows } = await t.db.pool.query("SELECT claim_expires_at FROM transfers WHERE id = $1", [id]);
    expect(rows[0].claim_expires_at).not.toBeNull();
  });

  it("stale fence (claim stolen mid-step) -> no write, 202 with the current snapshot", async () => {
    const { session, id } = await funded();
    await step(session, id); // SETTLEMENT_PENDING / BROADCAST
    const before = (await readJson(await get(session, id))).data;
    const f = fake();
    const original = f.step.bind(f);
    vi.spyOn(f, "step").mockImplementation(async (intent, fence) => {
      // Another processor takes over after our lease "expired".
      await t.db.pool.query("UPDATE transfers SET claim_epoch = claim_epoch + 1 WHERE id = $1", [id]);
      return original(intent, fence);
    });
    const res = await advance(session, id);
    expect(res.status).toBe(202);
    expect((await readJson(res)).data).toEqual(before);
  });

  it("payout UNKNOWN once: stays PAYOUT_PENDING, next advance completes with the same request_id", async () => {
    const { session, id } = await funded();
    const ownerId = session.ownerId;
    const deps = { payoutSimulator: createPayoutSimulator({ unknownHook: unknownOncePerRequest() }) };
    const run = () => advanceTransfer({ ownerId, transferId: id }, deps);

    for (let i = 0; i < 10; i++) {
      const r = await run();
      if (r.snapshot.status === "PAYOUT_PENDING") break;
    }
    const attemptBefore = (await t.db.pool.query("SELECT * FROM payout_attempts WHERE transfer_id = $1", [id])).rows;
    expect(attemptBefore).toHaveLength(1);
    expect(attemptBefore[0].status).toBe("PENDING");

    const unknown = await run();
    expect(unknown.status).toBe(202);
    expect(unknown.snapshot).toMatchObject({
      status: "PAYOUT_PENDING",
      nextAction: "ADVANCE",
      payout: { status: "UNKNOWN" },
    });
    const mid = (await t.db.pool.query("SELECT * FROM payout_attempts WHERE transfer_id = $1", [id])).rows;
    expect(mid).toHaveLength(1);
    expect(mid[0]).toMatchObject({ status: "UNKNOWN", request_id: attemptBefore[0].request_id });

    const done = await run();
    expect(done.status).toBe(200);
    expect(done.snapshot).toMatchObject({ status: "COMPLETED_SIMULATED", payout: { status: "PAID" } });
    const after = (await t.db.pool.query("SELECT * FROM payout_attempts WHERE transfer_id = $1", [id])).rows;
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ status: "PAID", request_id: attemptBefore[0].request_id });
  });

  it("other owner -> 404; bad origin -> 403; extra body -> 400; no session -> 401", async () => {
    const { session, id } = await funded();
    const before = (await readJson(await get(session, id))).data;

    const other = await seedSession(t.db.pool);
    const notMine = await advance(other, id);
    expect(notMine.status).toBe(404);
    expect((await readJson(notMine)).error?.code).toBe("NOT_FOUND");

    const missing = await advance(session, "tr_does-not-exist");
    expect(missing.status).toBe(404);

    expect((await advance(session, id, {}, "https://evil.example")).status).toBe(403);
    expect((await advance(session, id, {}, null)).status).toBe(403);

    const extra = await advance(session, id, { status: "COMPLETED_SIMULATED" });
    expect(extra.status).toBe(400);
    expect((await readJson(extra)).error?.code).toBe("INVALID_INPUT");

    const anon = await advancePOST(apiRequest(`/api/demo/transfers/${id}/advance`, { body: {} }), idCtx(id));
    expect(anon.status).toBe(401);

    expect((await readJson(await get(session, id))).data).toEqual(before);
    expect(fake().stats(id).steps).toBe(0);
  });
});
