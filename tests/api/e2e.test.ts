import { expect, it, vi } from "vitest";
import { POST as advancePOST } from "@/app/api/demo/transfers/[id]/advance/route";
import { POST as retryPOST } from "@/app/api/demo/transfers/[id]/payout-retry/route";
import { RECEIPT_SUMMARY } from "@/domain";
import { getSettlementModule, type FakeSettlementModule } from "@/settlement";
import { dbFenceGuard } from "@/settlement/db-fence-guard";
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

const retry = (s: TestSession, id: string, key: string | null, payload: unknown = {}, origin?: string | null) =>
  retryPOST(
    apiRequest(`/api/demo/transfers/${id}/payout-retry`, {
      cookie: s.cookie,
      idempotencyKey: key,
      body: payload,
      ...(origin === undefined ? {} : { origin }),
    }),
    idCtx(id),
  );

const fake = () => getSettlementModule({ fenceGuard: dbFenceGuard }) as FakeSettlementModule;

const NORMAL_PATH = [
  "FUNDING_PENDING",
  "FUNDED_SIMULATED",
  "SETTLEMENT_PENDING",
  "SETTLED",
  "PAYOUT_PENDING",
  "COMPLETED_SIMULATED",
];

describeDb("e2e: create -> fund -> advance -> payout-retry", () => {
  const t = useApiTestDb();

  async function funded(scenario = "HAPPY_PATH") {
    const { session, quote } = await seedSessionWithQuote(t.db.pool);
    const id = (await readJson(await create(session, newKey(), body(quote, scenario)))).data.id as string;
    expect((await fund(session, id, newKey())).status).toBe(200);
    return { session, id };
  }

  /** Call advance until nextAction is no longer ADVANCE; returns every response's status and snapshot. */
  async function drive(session: TestSession, id: string, max = 20) {
    const steps: { status: number; data: Record<string, unknown> & { nextAction: string; version: number } }[] = [];
    for (let i = 0; i < max; i++) {
      const res = await advance(session, id);
      const json = await readJson(res);
      steps.push({ status: res.status, data: json.data });
      if (json.data.nextAction !== "ADVANCE") return steps;
    }
    throw new Error("advance did not settle");
  }

  async function payoutAttempts(id: string) {
    const { rows } = await t.db.pool.query(
      "SELECT attempt_no, request_id, status, reference FROM payout_attempts WHERE transfer_id = $1 ORDER BY attempt_no",
      [id],
    );
    return rows as { attempt_no: number; request_id: string; status: string; reference: string | null }[];
  }

  it("happy path reaches COMPLETED_SIMULATED with receipt, evidence and the normal event path", async () => {
    const { session, id } = await funded();
    const steps = await drive(session, id);

    // Every intermediate step is 202; the final one is 200.
    expect(steps.slice(0, -1).every((s) => s.status === 202)).toBe(true);
    expect(steps.at(-1)?.status).toBe(200);

    const final = (await readJson(await get(session, id))).data;
    expect(final).toMatchObject({
      status: "COMPLETED_SIMULATED",
      nextAction: "NONE",
      lastIssue: null,
      funding: { status: "ACCEPTED" },
      settlement: { mode: "TESTNET", status: "CONFIRMED", chainId: 43113 },
      payout: { mode: "SIMULATED", status: "PAID" },
      receipt: { summary: RECEIPT_SUMMARY },
    });
    expect(final.receipt.summary).toBe("Demo completed: testnet settlement confirmed; THB payout simulated.");
    expect(final.settlement.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(final.settlement.verifiedAt).toEqual(expect.any(String));
    expect(final.settlement.explorerUrl).toContain(final.settlement.txHash);
    expect(final.events.map((e: { status: string }) => e.status)).toEqual(NORMAL_PATH);
    expect(final.events.map((e: { sequence: number }) => e.sequence)).toEqual([1, 2, 3, 4, 5, 6]);

    const stats = fake().stats(id);
    expect(stats.attemptsCreated).toBe(1);
    expect(stats.distinctHashes).toBe(1);

    const attempts = await payoutAttempts(id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ attempt_no: 1, status: "PAID" });
    expect(final.payout.reference).toBe(attempts[0]?.reference);

    // Advancing a completed transfer is a 200 no-op.
    const again = await advance(session, id);
    expect(again.status).toBe(200);
    expect((await readJson(again)).data.version).toBe(final.version);
  });

  it("GET during the flow never changes version", async () => {
    const { session, id } = await funded();
    for (let i = 0; i < 6; i++) {
      const a = (await readJson(await get(session, id))).data;
      const b = (await readJson(await get(session, id))).data;
      expect(b.version).toBe(a.version);
      expect(b).toEqual(a);
      if (a.nextAction !== "ADVANCE") break;
      await advance(session, id);
    }
    expect((await readJson(await get(session, id))).data.status).toBe("COMPLETED_SIMULATED");
  });

  it("FUNDING_DECLINED: advance is a 200 no-op and never calls settlement", async () => {
    const { session, id } = await funded("FUNDING_DECLINED");
    const stepSpy = vi.spyOn(fake(), "step");
    const before = (await readJson(await get(session, id))).data;
    const res = await advance(session, id);
    expect(res.status).toBe(200);
    const after = (await readJson(res)).data;
    expect(after).toEqual(before);
    expect(after).toMatchObject({ status: "FUNDING_FAILED", nextAction: "NONE" });
    expect(stepSpy).not.toHaveBeenCalled();
    expect(fake().stats(id).steps).toBe(0);
  });

  it("FUNDING_PENDING: advance is a 200 no-op", async () => {
    const { session, quote } = await seedSessionWithQuote(t.db.pool);
    const id = (await readJson(await create(session, newKey(), body(quote)))).data.id as string;
    const res = await advance(session, id);
    expect(res.status).toBe(200);
    expect((await readJson(res)).data).toMatchObject({ status: "FUNDING_PENDING", version: 1 });
  });

  it("PAYOUT_FAILED scenario: retry completes without a second settlement; replay and late keys are safe", async () => {
    const { session, id } = await funded("PAYOUT_FAILED");
    const steps = await drive(session, id);
    expect(steps.at(-1)?.status).toBe(200);
    const failed = steps.at(-1)?.data as Record<string, unknown>;
    expect(failed).toMatchObject({
      status: "PAYOUT_FAILED",
      nextAction: "RETRY_PAYOUT",
      settlement: { status: "CONFIRMED" },
      payout: { status: "FAILED" },
      lastIssue: { code: "PAYOUT_FAILED", retryable: true },
      receipt: null,
    });
    const settlementSteps = fake().stats(id).steps;
    const txHash = (failed.settlement as { txHash: string }).txHash;

    // Advancing a PAYOUT_FAILED transfer is a no-op (retry is explicit).
    expect((await advance(session, id)).status).toBe(200);

    const key = newKey();
    const r1 = await retry(session, id, key);
    expect(r1.status).toBe(202);
    const r1json = await readJson(r1);
    expect(r1json.meta.replayed).toBe(false);
    expect(r1json.data).toMatchObject({
      status: "PAYOUT_PENDING",
      nextAction: "ADVANCE",
      payout: { status: "PENDING" },
      lastIssue: null,
    });
    expect(await payoutAttempts(id)).toHaveLength(2);

    const done = await drive(session, id);
    const final = done.at(-1)?.data as Record<string, unknown>;
    expect(final).toMatchObject({
      status: "COMPLETED_SIMULATED",
      nextAction: "NONE",
      payout: { status: "PAID" },
      settlement: { status: "CONFIRMED", txHash },
      receipt: { summary: RECEIPT_SUMMARY },
    });
    expect((final.events as { status: string }[]).map((e) => e.status)).toEqual([
      "FUNDING_PENDING",
      "FUNDED_SIMULATED",
      "SETTLEMENT_PENDING",
      "SETTLED",
      "PAYOUT_PENDING",
      "PAYOUT_FAILED",
      "PAYOUT_PENDING",
      "COMPLETED_SIMULATED",
    ]);

    // No second settlement: the fake was not stepped by the retry or the payout.
    expect(fake().stats(id)).toMatchObject({ steps: settlementSteps, attemptsCreated: 1, distinctHashes: 1 });

    const attempts = await payoutAttempts(id);
    expect(attempts.map((a) => [a.attempt_no, a.status])).toEqual([
      [1, "FAILED"],
      [2, "PAID"],
    ]);
    expect(attempts[0]?.request_id).not.toBe(attempts[1]?.request_id);

    // Same key after the transfer moved on: replayed, current snapshot, no new attempt.
    const replay = await retry(session, id, key);
    expect(replay.status).toBe(200);
    const replayJson = await readJson(replay);
    expect(replayJson.meta.replayed).toBe(true);
    expect(replayJson.data.status).toBe("COMPLETED_SIMULATED");
    expect(await payoutAttempts(id)).toHaveLength(2);

    // New key on a COMPLETED transfer: 409 INVALID_STATE.
    const late = await retry(session, id, newKey());
    expect(late.status).toBe(409);
    expect((await readJson(late)).error?.code).toBe("INVALID_STATE");
    expect(await payoutAttempts(id)).toHaveLength(2);
  });

  it("concurrent same-key payout retries create exactly one attempt", async () => {
    const { session, id } = await funded("PAYOUT_FAILED");
    await drive(session, id);
    const key = newKey();
    const responses = await Promise.all(Array.from({ length: 5 }, () => retry(session, id, key)));
    const metas = await Promise.all(responses.map(async (r) => [r.status, (await readJson(r)).meta.replayed]));
    expect(metas.filter(([, replayed]) => replayed === false)).toEqual([[202, false]]);
    expect(metas.filter(([, replayed]) => replayed === true).every(([s]) => s === 200)).toBe(true);
    expect(await payoutAttempts(id)).toHaveLength(2);
  });

  it("payout-retry validation: missing key 400, extra body 400, bad origin 403, wrong state 409, other owner 404", async () => {
    const { session, id } = await funded("PAYOUT_FAILED");
    await drive(session, id);

    const noKey = await retry(session, id, null);
    expect(noKey.status).toBe(400);
    expect((await readJson(noKey)).error?.code).toBe("IDEMPOTENCY_KEY_REQUIRED");

    const extra = await retry(session, id, newKey(), { status: "PAYOUT_PENDING" });
    expect(extra.status).toBe(400);
    expect((await readJson(extra)).error?.code).toBe("INVALID_INPUT");

    expect((await retry(session, id, newKey(), {}, "https://evil.example")).status).toBe(403);

    const other = await seedSession(t.db.pool);
    const notMine = await retry(other, id, newKey());
    expect(notMine.status).toBe(404);
    expect((await readJson(notMine)).error?.code).toBe("NOT_FOUND");

    // A transfer that is not PAYOUT_FAILED.
    const happy = await funded();
    const wrong = await retry(happy.session, happy.id, newKey());
    expect(wrong.status).toBe(409);
    expect((await readJson(wrong)).error?.code).toBe("INVALID_STATE");

    // None of the rejected calls changed anything.
    expect((await readJson(await get(session, id))).data.status).toBe("PAYOUT_FAILED");
    expect(await payoutAttempts(id)).toHaveLength(1);
  });
});
