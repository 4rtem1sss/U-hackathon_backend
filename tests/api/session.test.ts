import { expect, it } from "vitest";
import { GET as recipientsGET } from "@/app/api/recipients/route";
import { POST as sessionPOST } from "@/app/api/demo/session/route";
import { hashSessionToken } from "@/server/session";
import { apiRequest, describeDb, readJson, TEST_ORIGIN, useApiTestDb } from "../server/helpers";

const post = (opts: Parameters<typeof apiRequest>[1] = {}) =>
  sessionPOST(apiRequest("/api/demo/session", opts), undefined);

/** `demo_session=<token>` from a Set-Cookie header. */
const cookiePair = (setCookie: string): string => setCookie.split(";")[0] ?? "";
const tokenOf = (setCookie: string): string => cookiePair(setCookie).slice("demo_session=".length);

describeDb("POST /api/demo/session", () => {
  const t = useApiTestDb();

  const recipientCount = async (ownerId: string) =>
    Number((await t.db.pool.query("SELECT count(*)::int AS n FROM recipients WHERE owner_id = $1", [ownerId])).rows[0].n);

  it("creates a session (200) with the cookie attributes", async () => {
    const before = Date.now();
    const res = await post();
    expect(res.status).toBe(200);
    const json = await readJson(res);
    expect(json.meta).toMatchObject({ apiVersion: "v1", replayed: false });
    expect(json.data).toEqual({
      sessionId: expect.stringMatching(/^ses_/),
      mode: "DEMO",
      expiresAt: expect.any(String),
    });
    const expiresAt = new Date(json.data.expiresAt);
    expect(expiresAt.toISOString()).toBe(json.data.expiresAt);
    expect(Math.abs(expiresAt.getTime() - (before + 86_400_000))).toBeLessThan(60_000);

    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("demo_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("Max-Age=86400");
    expect(setCookie).toContain(`Expires=${expiresAt.toUTCString()}`);
    expect(setCookie).not.toContain("Secure");
  });

  it("stores only the SHA-256 of the token and never returns the token in the body", async () => {
    const res = await post();
    const text = await res.text();
    const json = JSON.parse(text) as { data: { sessionId: string } };
    const token = tokenOf(res.headers.get("set-cookie") ?? "");
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(text).not.toContain(token);
    expect(json.data.sessionId).not.toBe(token);

    const { rows } = await t.db.pool.query("SELECT * FROM demo_sessions WHERE id = $1", [json.data.sessionId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toBe(hashSessionToken(token));
    for (const value of Object.values(rows[0])) expect(String(value)).not.toContain(token);
  });

  it("creates exactly one synthetic recipient for the new owner", async () => {
    const res = await post();
    const { sessionId } = (await readJson(res)).data;
    const { rows } = await t.db.pool.query("SELECT owner_id FROM demo_sessions WHERE id = $1", [sessionId]);
    const ownerId = rows[0].owner_id as string;
    expect(ownerId).toMatch(/^own_/);
    expect(await recipientCount(ownerId)).toBe(1);
    const r = await t.db.pool.query("SELECT * FROM recipients WHERE owner_id = $1", [ownerId]);
    expect(r.rows[0].id).toMatch(/^rcp_/);
    expect(r.rows[0]).toMatchObject({
      name: "Demo Recipient",
      bank_label: "Demo Thai Bank",
      account_display: "TEST ACCOUNT 0001",
      country: "TH",
      currency: "THB",
      is_synthetic: true,
    });
  });

  it("resumes an active session: same sessionId, no Set-Cookie, still one recipient", async () => {
    const first = await post();
    const firstJson = await readJson(first);
    const cookie = cookiePair(first.headers.get("set-cookie") ?? "");

    const again = await post({ cookie });
    expect(again.status).toBe(200);
    expect(again.headers.get("set-cookie")).toBeNull();
    const againJson = await readJson(again);
    expect(againJson.data.sessionId).toBe(firstJson.data.sessionId);
    expect(againJson.data.expiresAt).toBe(firstJson.data.expiresAt);

    const { rows } = await t.db.pool.query("SELECT owner_id FROM demo_sessions WHERE id = $1", [firstJson.data.sessionId]);
    expect(await recipientCount(rows[0].owner_id)).toBe(1);
  });

  it("issues a new session for an unknown cookie", async () => {
    const res = await post({ cookie: "demo_session=not-a-real-token" });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("demo_session=");
    const { rows } = await t.db.pool.query("SELECT count(*)::int AS n FROM demo_sessions WHERE id = $1", [
      (await readJson(res)).data.sessionId,
    ]);
    expect(rows[0].n).toBe(1);
  });

  it("issues a new session when the cookie's session has expired", async () => {
    const first = await post();
    const firstJson = await readJson(first);
    const cookie = cookiePair(first.headers.get("set-cookie") ?? "");
    await t.db.pool.query("UPDATE demo_sessions SET expires_at = now() - interval '1 second' WHERE id = $1", [
      firstJson.data.sessionId,
    ]);

    const again = await post({ cookie });
    expect(again.status).toBe(200);
    expect(again.headers.get("set-cookie")).toContain("demo_session=");
    expect(tokenOf(again.headers.get("set-cookie") ?? "")).not.toBe(cookie.slice("demo_session=".length));
    expect((await readJson(again)).data.sessionId).not.toBe(firstJson.data.sessionId);
  });

  it("rejects a missing Origin with 403 ORIGIN_NOT_ALLOWED", async () => {
    const res = await post({ origin: null });
    expect(res.status).toBe(403);
    expect((await readJson(res)).error?.code).toBe("ORIGIN_NOT_ALLOWED");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("rejects a foreign Origin with 403 ORIGIN_NOT_ALLOWED", async () => {
    const res = await post({ origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect((await readJson(res)).error?.code).toBe("ORIGIN_NOT_ALLOWED");
  });

  it("marks the cookie Secure for an https request URL", async () => {
    const res = await sessionPOST(
      new Request("https://localhost:3000/api/demo/session", {
        method: "POST",
        headers: { origin: "https://localhost:3000", host: "localhost:3000", "content-type": "application/json" },
        body: "{}",
      }),
      undefined,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("; Secure");
  });

  it("marks the cookie Secure when x-forwarded-proto is https", async () => {
    const res = await sessionPOST(
      new Request(`${TEST_ORIGIN}/api/demo/session`, {
        method: "POST",
        headers: { origin: TEST_ORIGIN, "x-forwarded-proto": "https, http", "content-type": "application/json" },
        body: "{}",
      }),
      undefined,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("; Secure");
  });

  it("issues a cookie that authenticates later requests", async () => {
    const res = await post();
    const cookie = cookiePair(res.headers.get("set-cookie") ?? "");
    const list = await recipientsGET(apiRequest("/api/recipients", { method: "GET", cookie }), undefined);
    expect(list.status).toBe(200);
  });
});
