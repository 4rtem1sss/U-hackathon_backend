import { expect, it } from "vitest";
import { POST as sessionPOST } from "@/app/api/demo/session/route";
import { GET as recipientsGET, POST as recipientsPOST } from "@/app/api/recipients/route";
import { RECIPIENT_LIMIT } from "@/domain/recipients";
import { apiRequest, describeDb, readJson, useApiTestDb } from "../server/helpers";

const newSessionCookie = async (): Promise<string> => {
  const res = await sessionPOST(apiRequest("/api/demo/session"), undefined);
  return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
};

const list = (cookie: string | null) =>
  recipientsGET(apiRequest("/api/recipients", { method: "GET", cookie }), undefined);

describeDb("GET /api/recipients", () => {
  useApiTestDb();

  it("rejects a request without a session cookie (401 UNAUTHENTICATED)", async () => {
    const res = await list(null);
    expect(res.status).toBe(401);
    expect((await readJson(res)).error?.code).toBe("UNAUTHENTICATED");
  });

  it("returns the session's one synthetic recipient with exactly the 7 public keys", async () => {
    const res = await list(await newSessionCookie());
    expect(res.status).toBe(200);
    const { data, meta } = await readJson(res);
    expect(meta).toMatchObject({ apiVersion: "v1", replayed: false });
    expect(data.recipients).toHaveLength(1);
    const r = data.recipients[0];
    expect(Object.keys(r).sort()).toEqual(
      ["accountDisplay", "bankLabel", "country", "currency", "id", "isSynthetic", "name"].sort(),
    );
    expect(r).toEqual({
      id: expect.stringMatching(/^rcp_/),
      name: "Demo Recipient",
      country: "TH",
      currency: "THB",
      bankLabel: "Demo Thai Bank",
      accountDisplay: "TEST ACCOUNT 0001",
      isSynthetic: true,
    });
  });

  it("scopes recipients to the session's owner", async () => {
    const a = await readJson(await list(await newSessionCookie()));
    const b = await readJson(await list(await newSessionCookie()));
    expect(a.data.recipients).toHaveLength(1);
    expect(b.data.recipients).toHaveLength(1);
    expect(a.data.recipients[0].id).not.toBe(b.data.recipients[0].id);
  });
});

const create = (cookie: string | null, body: unknown, origin?: string | null) =>
  recipientsPOST(
    apiRequest("/api/recipients", { cookie, body, ...(origin === undefined ? {} : { origin }) }),
    undefined,
  );

const valid = { name: "สมชาย ใจดี", bankCode: "KBANK", accountNumber: "123-4-56789-0" };

describeDb("POST /api/recipients", () => {
  const t = useApiTestDb();

  it("creates a recipient (201) with a last-4 display and lists it", async () => {
    const cookie = await newSessionCookie();
    const res = await create(cookie, valid);
    expect(res.status).toBe(201);
    const { data } = await readJson(res);
    expect(data).toEqual({
      id: expect.stringMatching(/^rcp_/),
      name: "สมชาย ใจดี",
      country: "TH",
      currency: "THB",
      bankLabel: "Kasikorn Bank",
      accountDisplay: "••7890",
      isSynthetic: true,
    });
    const listed = (await readJson(await list(cookie))).data.recipients;
    expect(listed.map((r: { id: string }) => r.id)).toContain(data.id);
  });

  it("full account number is not stored", async () => {
    const cookie = await newSessionCookie();
    await create(cookie, valid);
    const { rows } = await t.db.pool.query("SELECT row_to_json(r)::text AS j FROM recipients r");
    for (const row of rows) expect(row.j).not.toContain("1234567890");
  });

  it("rejects bad fields with 400 INVALID_INPUT and per-field errors", async () => {
    const cookie = await newSessionCookie();
    const res = await create(cookie, { name: " ", bankCode: "CITI", accountNumber: "12" });
    expect(res.status).toBe(400);
    const { error } = await readJson(res);
    expect(error?.code).toBe("INVALID_INPUT");
    expect(Object.keys(error?.fieldErrors ?? {}).sort()).toEqual(["accountNumber", "bankCode", "name"]);
  });

  it("rejects extra fields", async () => {
    const res = await create(await newSessionCookie(), { ...valid, accountDisplay: "••0000" });
    expect(res.status).toBe(400);
  });

  it("requires a session (401) and a same-origin request (403)", async () => {
    expect((await create(null, valid)).status).toBe(401);
    expect((await create(await newSessionCookie(), valid, "https://evil.example")).status).toBe(403);
  });

  it("keeps recipients private to their session", async () => {
    const a = await newSessionCookie();
    const b = await newSessionCookie();
    const { data } = await readJson(await create(a, valid));
    const bList = (await readJson(await list(b))).data.recipients;
    expect(bList.map((r: { id: string }) => r.id)).not.toContain(data.id);
  });

  it(`caps a session at ${RECIPIENT_LIMIT} recipients (409 RECIPIENT_LIMIT)`, async () => {
    const cookie = await newSessionCookie();
    for (let i = 1; i < RECIPIENT_LIMIT; i++) expect((await create(cookie, valid)).status).toBe(201);
    const res = await create(cookie, valid);
    expect(res.status).toBe(409);
    expect((await readJson(res)).error?.code).toBe("RECIPIENT_LIMIT");
  });
});
