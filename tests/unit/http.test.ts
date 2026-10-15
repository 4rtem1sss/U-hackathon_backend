import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  API_VERSION,
  ApiError,
  ERROR_CODES,
  REQUEST_ID_HEADER,
  currentRequestId,
  errorResponse,
  isOriginAllowed,
  ok,
  parseJsonBody,
  toApiError,
  withHandler,
} from "@/lib/http";
import { GET as healthGET } from "@/app/api/health/route";

const REQ_ID_RE = /^req_[0-9a-f-]{36}$/;

describe("ok()", () => {
  it("wraps data in the success envelope with defaults", async () => {
    const res = ok({ hello: "world" }, { requestId: "req_test" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe("req_test");
    expect(await res.json()).toEqual({
      data: { hello: "world" },
      meta: { requestId: "req_test", apiVersion: "v1", replayed: false },
    });
  });

  it("supports status and replayed", async () => {
    const res = ok({ id: "tr_1" }, { status: 201, replayed: true });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.meta.replayed).toBe(true);
    expect(body.meta.apiVersion).toBe(API_VERSION);
    expect(body.meta.requestId).toMatch(REQ_ID_RE);
  });
});

describe("error mapping", () => {
  it("has the full api-contract section 9 table", () => {
    const table = Object.fromEntries(Object.entries(ERROR_CODES).map(([k, v]) => [k, v.status]));
    expect(table).toEqual({
      INVALID_INPUT: 400,
      IDEMPOTENCY_KEY_REQUIRED: 400,
      UNAUTHENTICATED: 401,
      ORIGIN_NOT_ALLOWED: 403,
      DEMO_DISABLED: 403,
      NOT_FOUND: 404,
      IDEMPOTENCY_CONFLICT: 409,
      QUOTE_ALREADY_ACCEPTED: 409,
      INVALID_STATE: 409,
      RECIPIENT_LIMIT: 409,
      QUOTE_EXPIRED: 410,
      UNSUPPORTED_CORRIDOR: 422,
      CHECKS_REJECTED: 422,
      CHECKS_REVIEW_REQUIRED: 422,
      RATE_LIMITED: 429,
      DEMO_BUDGET_EXCEEDED: 429,
      INTERNAL_ERROR: 500,
      DEPENDENCY_UNAVAILABLE: 503,
    });
  });

  it("renders an ApiError as the error envelope", async () => {
    const res = errorResponse(new ApiError("IDEMPOTENCY_CONFLICT"), { requestId: "req_e" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: {
        code: "IDEMPOTENCY_CONFLICT",
        message: "This request key was already used with different input.",
        retryable: false,
        fieldErrors: {},
      },
      meta: { requestId: "req_e", apiVersion: "v1" },
    });
  });

  it("includes field errors and Retry-After", async () => {
    const v = await errorResponse(ApiError.invalidInput({ quoteId: "is required" })).json();
    expect(v.error.code).toBe("INVALID_INPUT");
    expect(v.error.fieldErrors).toEqual({ quoteId: "is required" });

    const r = errorResponse(new ApiError("RATE_LIMITED", { retryAfterSeconds: 2.2 }));
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("3");
    expect((await r.json()).error.retryable).toBe(true);
  });

  it("maps unknown errors to 500 INTERNAL_ERROR without leaking details", async () => {
    const secret = new Error("password=hunter2 at db.ts:12");
    const res = errorResponse(secret);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("db.ts");
    const body = JSON.parse(text);
    expect(body.error).toEqual({
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred.",
      retryable: false,
      fieldErrors: {},
    });
    expect(body.meta.requestId).toMatch(REQ_ID_RE);
  });

  it("maps ZodError to INVALID_INPUT with field paths", () => {
    const parsed = z.object({ a: z.object({ b: z.string() }) }).safeParse({ a: { b: 1 } });
    expect(parsed.success).toBe(false);
    const err = toApiError(parsed.error);
    expect(err.code).toBe("INVALID_INPUT");
    expect(Object.keys(err.fieldErrors)).toEqual(["a.b"]);
  });
});

describe("parseJsonBody()", () => {
  const schema = z.strictObject({ quoteId: z.string() });
  const post = (body: string) => new Request("http://x/api", { method: "POST", body });

  it("parses valid JSON", async () => {
    await expect(parseJsonBody(post('{"quoteId":"qt_1"}'), schema)).resolves.toEqual({ quoteId: "qt_1" });
  });

  it("rejects malformed JSON and unknown fields", async () => {
    await expect(parseJsonBody(post("{"), schema)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(parseJsonBody(post('{"quoteId":"q","fee":"1"}'), schema)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });
});

describe("isOriginAllowed()", () => {
  const req = (headers: Record<string, string>) => new Request("http://api.local/api/x", { method: "POST", headers });

  it("allows configured origins", () => {
    expect(isOriginAllowed(req({ origin: "https://app.example.com", host: "api.local" }), ["https://app.example.com/"])).toBe(true);
  });

  it("allows the request's own host", () => {
    expect(isOriginAllowed(req({ origin: "https://demo.vercel.app", host: "demo.vercel.app" }), [])).toBe(true);
    expect(
      isOriginAllowed(req({ origin: "https://demo.vercel.app", host: "internal:3000", "x-forwarded-host": "demo.vercel.app" }), []),
    ).toBe(true);
  });

  it("rejects missing, null, malformed and foreign origins", () => {
    expect(isOriginAllowed(req({ host: "api.local" }), [])).toBe(false);
    expect(isOriginAllowed(req({ origin: "null", host: "api.local" }), [])).toBe(false);
    expect(isOriginAllowed(req({ origin: "not a url", host: "api.local" }), [])).toBe(false);
    expect(isOriginAllowed(req({ origin: "https://evil.example", host: "api.local" }), ["https://app.example.com"])).toBe(false);
  });
});

describe("withHandler()", () => {
  it("sets a request ID visible to the handler and in the response", async () => {
    let seen = "";
    const h = withHandler(async (_req, _ctx, rc) => {
      seen = rc.requestId;
      expect(currentRequestId()).toBe(rc.requestId);
      return ok({ x: 1 });
    });
    const res = await h(new Request("http://x/"), undefined);
    const body = await res.json();
    expect(seen).toMatch(REQ_ID_RE);
    expect(body.meta.requestId).toBe(seen);
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe(seen);
  });

  it("catches ApiError and unknown errors", async () => {
    const logger = { error: vi.fn() };
    const notFound = withHandler(() => {
      throw ApiError.notFound();
    }, { logger });
    expect((await notFound(new Request("http://x/"), undefined)).status).toBe(404);
    expect(logger.error).not.toHaveBeenCalled();

    const boom = withHandler(() => {
      throw new Error("boom");
    }, { logger });
    const res = await boom(new Request("http://x/"), undefined);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe(body.meta.requestId);
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it("enforces the origin check when configured", async () => {
    const h = withHandler(() => ok({}), { allowedOrigins: () => ["https://app.example.com"] });
    const bad = await h(new Request("http://api/", { method: "POST", headers: { origin: "https://evil.example" } }), undefined);
    expect(bad.status).toBe(403);
    expect((await bad.json()).error.code).toBe("ORIGIN_NOT_ALLOWED");
    const good = await h(new Request("http://api/", { method: "POST", headers: { origin: "https://app.example.com" } }), undefined);
    expect(good.status).toBe(200);
  });
});

describe("GET /api/health", () => {
  it("returns the success envelope", async () => {
    const res = await healthGET(new Request("http://x/api/health"), undefined);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ status: "ok" });
    expect(body.meta).toMatchObject({ apiVersion: "v1", replayed: false });
  });
});
