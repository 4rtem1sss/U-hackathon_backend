import { expect, it } from "vitest";
import { POST as sessionPOST } from "@/app/api/demo/session/route";
import { GET as recipientsGET } from "@/app/api/recipients/route";
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
