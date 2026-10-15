import { expect, it } from "vitest";
import { POST as quotesPOST } from "@/app/api/quotes/route";
import { insertRecipient } from "@/db/repos/recipients";
import { newId } from "@/lib/ids";
import { apiRequest, describeDb, newKey, readJson, seedSession, useApiTestDb, type TestSession } from "../server/helpers";
import { create } from "./client";

const ID = (prefix: string) => new RegExp(`^${prefix}_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`);

describeDb("POST /api/quotes", () => {
  const t = useApiTestDb();

  const post = (session: TestSession | null, payload: unknown, origin?: string | null) =>
    quotesPOST(
      apiRequest("/api/quotes", {
        cookie: session?.cookie ?? null,
        body: payload,
        ...(origin === undefined ? {} : { origin }),
      }),
      undefined,
    );

  async function seedWithRecipient() {
    const session = await seedSession(t.db.pool);
    const recipient = await insertRecipient(t.db.pool, {
      id: newId("rcp"),
      ownerId: session.ownerId,
      name: "Somchai Demo",
      bankLabel: "Demo Bank TH",
      accountDisplay: "xxx-x-x1234-x",
    });
    return { session, recipient };
  }

  const quoteCount = async (ownerId: string) =>
    Number((await t.db.pool.query("SELECT count(*)::int AS n FROM quotes WHERE owner_id = $1", [ownerId])).rows[0].n);
  const checkResults = async (ownerId: string) =>
    (await t.db.pool.query("SELECT result FROM quote_checks WHERE owner_id = $1", [ownerId])).rows.map((r) => r.result);

  it("creates a quote (201) with the contract shape and a linked PASS check", async () => {
    const { session, recipient } = await seedWithRecipient();
    const res = await post(session, { recipientId: recipient.id, sourceDebitMinor: "1000", demoCheckScenario: "PASS" });
    expect(res.status).toBe(201);
    const json = await readJson(res);
    expect(json.meta).toMatchObject({ apiVersion: "v1", replayed: false });
    const d = json.data;
    expect(d).toEqual({
      id: expect.stringMatching(ID("qt")),
      recipientId: recipient.id,
      sourceCountry: "US",
      destinationCountry: "TH",
      sourceCurrency: "USD",
      destinationCurrency: "THB",
      sourceDebitMinor: "1000",
      feeMinor: "20",
      conversionPrincipalMinor: "980",
      fxRateNumerator: "35",
      fxRateDenominator: "1",
      destinationNetMinor: "34300",
      settlementTokenUnits: "9800000",
      fixtureVersion: "fixture-us-th-v1",
      createdAt: expect.any(String),
      expiresAt: expect.any(String),
      mode: "DEMO",
      fundingSimulated: true,
      fxSimulated: true,
      payoutSimulated: true,
      settlementMode: "TESTNET",
      chainId: 43113,
      arrivalEstimate: null,
      checks: { mode: "SIMULATED", result: "PASS", reference: expect.stringMatching(ID("chk")) },
    });
    expect((Date.parse(d.expiresAt) - Date.parse(d.createdAt)) / 1000).toBe(300);
    const row = (await t.db.pool.query("SELECT check_id, check_result, status FROM quotes WHERE id = $1", [d.id])).rows[0];
    expect(row).toEqual({ check_id: d.checks.reference, check_result: "PASS", status: "OPEN" });
  });

  it("treats an omitted demoCheckScenario as PASS", async () => {
    const { session, recipient } = await seedWithRecipient();
    const res = await post(session, { recipientId: recipient.id, sourceDebitMinor: "1000" });
    expect(res.status).toBe(201);
    expect((await readJson(res)).data.checks.result).toBe("PASS");
    expect(await checkResults(session.ownerId)).toEqual(["PASS"]);
  });

  it.each([
    ["REJECT", "CHECKS_REJECTED"],
    ["REVIEW", "CHECKS_REVIEW_REQUIRED"],
  ])("%s -> 422 %s, keeps the check row and issues no quote", async (scenario, code) => {
    const { session, recipient } = await seedWithRecipient();
    const res = await post(session, { recipientId: recipient.id, sourceDebitMinor: "1000", demoCheckScenario: scenario });
    expect(res.status).toBe(422);
    expect((await readJson(res)).error?.code).toBe(code);
    expect(await checkResults(session.ownerId)).toEqual([scenario]);
    expect(await quoteCount(session.ownerId)).toBe(0);
  });

  it("rounds the fee up through the API", async () => {
    const { session, recipient } = await seedWithRecipient();
    const res = await post(session, { recipientId: recipient.id, sourceDebitMinor: "101" });
    expect(res.status).toBe(201);
    expect((await readJson(res)).data).toMatchObject({ feeMinor: "3", conversionPrincipalMinor: "98" });
  });

  it.each([
    ["99", { sourceDebitMinor: "99" }],
    ["10001", { sourceDebitMinor: "10001" }],
    ["decimal", { sourceDebitMinor: "10.00" }],
    ["leading zero", { sourceDebitMinor: "0100" }],
    ["number", { sourceDebitMinor: 1000 }],
  ])("rejects sourceDebitMinor %s with 400 INVALID_INPUT", async (_name, extra) => {
    const { session, recipient } = await seedWithRecipient();
    const res = await post(session, { recipientId: recipient.id, ...extra });
    expect(res.status).toBe(400);
    const err = (await readJson(res)).error;
    expect(err?.code).toBe("INVALID_INPUT");
    expect(err?.fieldErrors).toHaveProperty("sourceDebitMinor");
    expect(await quoteCount(session.ownerId)).toBe(0);
  });

  it.each([
    ["missing recipientId", { sourceDebitMinor: "1000" }],
    ["extra field", { recipientId: "rcp_x", sourceDebitMinor: "1000", feeMinor: "0" }],
    ["bad demoCheckScenario", { recipientId: "rcp_x", sourceDebitMinor: "1000", demoCheckScenario: "MAYBE" }],
  ])("rejects %s with 400 INVALID_INPUT", async (_name, payload) => {
    const { session } = await seedWithRecipient();
    const res = await post(session, payload);
    expect(res.status).toBe(400);
    expect((await readJson(res)).error?.code).toBe("INVALID_INPUT");
  });

  it("404 NOT_FOUND for an unknown recipient", async () => {
    const { session } = await seedWithRecipient();
    const res = await post(session, { recipientId: newId("rcp"), sourceDebitMinor: "1000" });
    expect(res.status).toBe(404);
    expect((await readJson(res)).error?.code).toBe("NOT_FOUND");
  });

  it("404 NOT_FOUND for another session's recipient", async () => {
    const { recipient } = await seedWithRecipient();
    const other = await seedSession(t.db.pool);
    const res = await post(other, { recipientId: recipient.id, sourceDebitMinor: "1000" });
    expect(res.status).toBe(404);
    expect((await readJson(res)).error?.code).toBe("NOT_FOUND");
    expect(await checkResults(other.ownerId)).toEqual([]);
  });

  it("401 without a session cookie", async () => {
    const res = await post(null, { recipientId: "rcp_x", sourceDebitMinor: "1000" });
    expect(res.status).toBe(401);
    expect((await readJson(res)).error?.code).toBe("UNAUTHENTICATED");
  });

  it("403 ORIGIN_NOT_ALLOWED without an allowed Origin", async () => {
    const { session, recipient } = await seedWithRecipient();
    const res = await post(session, { recipientId: recipient.id, sourceDebitMinor: "1000" }, null);
    expect(res.status).toBe(403);
    expect((await readJson(res)).error?.code).toBe("ORIGIN_NOT_ALLOWED");
  });

  it("a created quote can be turned into a transfer with equal amounts", async () => {
    const { session, recipient } = await seedWithRecipient();
    const q = (await readJson(await post(session, { recipientId: recipient.id, sourceDebitMinor: "1000" }))).data;
    const res = await create(session, newKey(), { quoteId: q.id, purpose: "PERSONAL_REMITTANCE", demoScenario: "HAPPY_PATH" });
    expect(res.status).toBe(201);
    const tr = (await readJson(res)).data;
    expect(tr.quoteId).toBe(q.id);
    expect(tr.amounts).toMatchObject({
      sourceDebitMinor: q.sourceDebitMinor,
      feeMinor: q.feeMinor,
      conversionPrincipalMinor: q.conversionPrincipalMinor,
      destinationNetMinor: q.destinationNetMinor,
      settlementTokenUnits: q.settlementTokenUnits,
    });
  });
});
