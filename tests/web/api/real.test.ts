import { describe, expect, it, vi } from "vitest";
import { ApiError, NetworkError } from "@/web/api/errors";
import { contractQuoteExample, contractSnapshotExample } from "@/web/api/fixtures";
import { createRealClient } from "@/web/api/real";

const meta = { requestId: "req_1", apiVersion: "v1", replayed: false };
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

describe("real client", () => {
  it("posts the quote request and unwraps data", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(201, { data: contractQuoteExample, meta }));
    const api = createRealClient({ fetchImpl });
    const q = await api.createQuote({ recipientId: "recipient_demo_th_001", sourceDebitMinor: "1000" });
    expect(q.id).toBe("quote_demo_001");
    const [path, init] = fetchImpl.mock.calls[0]!;
    expect(path).toBe("/api/quotes");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ recipientId: "recipient_demo_th_001", sourceDebitMinor: "1000" });
    expect(init.credentials).toBe("same-origin");
  });

  it("sends the Idempotency-Key on transfer creation", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(201, { data: contractSnapshotExample, meta }));
    const api = createRealClient({ fetchImpl });
    await api.createTransfer({ quoteId: "quote_demo_001", purpose: "PERSONAL_REMITTANCE", demoScenario: "HAPPY_PATH" }, "key-1");
    expect(fetchImpl.mock.calls[0]![1].headers["Idempotency-Key"]).toBe("key-1");
  });

  it("turns the error envelope into an ApiError", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(410, {
      error: { code: "QUOTE_EXPIRED", message: "Quote expired.", retryable: false, fieldErrors: {} },
      meta: { requestId: "req_err", apiVersion: "v1" },
    }, { "Retry-After": "3" }));
    const api = createRealClient({ fetchImpl });
    const err = await api.getTransfer("t1").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 410, code: "QUOTE_EXPIRED", requestId: "req_err", retryAfterSeconds: 3 });
  });

  it("re-creates the session once on 401 and retries", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json(401, { error: { code: "UNAUTHENTICATED", message: "No session.", retryable: false } }))
      .mockResolvedValueOnce(json(200, { data: { sessionId: "s1", mode: "DEMO", expiresAt: "2026-10-17T00:00:00Z" }, meta }))
      .mockResolvedValueOnce(json(200, { data: contractSnapshotExample, meta }));
    const api = createRealClient({ fetchImpl });
    const s = await api.getTransfer("transfer_demo_001");
    expect(s.id).toBe("transfer_demo_001");
    expect(fetchImpl.mock.calls.map((c) => c[0])).toEqual([
      "/api/transfers/transfer_demo_001", "/api/demo/session", "/api/transfers/transfer_demo_001",
    ]);
  });

  it("reports schema mismatch but still returns data", async () => {
    const drifted = { ...contractSnapshotExample, status: "SOMETHING_NEW" };
    const fetchImpl = vi.fn().mockResolvedValue(json(200, { data: drifted, meta }));
    const onSchemaMismatch = vi.fn();
    const api = createRealClient({ fetchImpl, onSchemaMismatch });
    const s = await api.getTransfer("transfer_demo_001");
    expect(s.status).toBe("SOMETHING_NEW");
    expect(onSchemaMismatch).toHaveBeenCalledWith("GET /api/transfers/transfer_demo_001", expect.arrayContaining([expect.stringContaining("status")]));
  });

  it("wraps fetch failures in NetworkError", async () => {
    const api = createRealClient({ fetchImpl: vi.fn().mockRejectedValue(new TypeError("offline")) });
    await expect(api.getRecipients()).rejects.toBeInstanceOf(NetworkError);
  });
});

describe("real client hardening", () => {
  it("marks schema-drifted snapshots so the UI can hold", async () => {
    const { isDrifted } = await import("@/web/api/drift");
    const drifted = { ...contractSnapshotExample, amounts: { ...contractSnapshotExample.amounts, destinationNetMinor: "343.00" } };
    const api = createRealClient({ fetchImpl: vi.fn().mockResolvedValue(json(200, { data: drifted, meta })) });
    expect(isDrifted(await api.getTransfer("transfer_demo_001"))).toBe(true);
    const ok = createRealClient({ fetchImpl: vi.fn().mockResolvedValue(json(200, { data: contractSnapshotExample, meta })) });
    expect(isDrifted(await ok.getTransfer("transfer_demo_001"))).toBe(false);
  });

  it("shares one session request across concurrent 401s", async () => {
    const unauth = () => json(401, { error: { code: "UNAUTHENTICATED", message: "No session.", retryable: false } });
    const session = () => json(201, { data: { sessionId: "s1", mode: "DEMO", expiresAt: "2026-10-17T00:00:00Z" }, meta });
    let authed = false;
    const fetchImpl = vi.fn(async (path: string) => {
      if (path === "/api/demo/session") {
        await new Promise((r) => setTimeout(r, 5));
        authed = true;
        return session();
      }
      return authed ? json(200, { data: contractSnapshotExample, meta }) : unauth();
    });
    const api = createRealClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await Promise.all([api.getTransfer("a"), api.getTransfer("b"), api.createSession()]);
    expect(fetchImpl.mock.calls.filter((c) => c[0] === "/api/demo/session")).toHaveLength(1);
  });
});
