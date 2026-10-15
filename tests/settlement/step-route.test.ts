import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/config/env";
import { POST } from "@/app/api/internal/settlement/step/route";
import { InMemoryFenceGuard, getSettlementModule, resetSettlementModuleForTests } from "@/settlement";
import { isInternalRpcAuthorized } from "@/settlement/internal-auth";

const SECRET = "s".repeat(40);
const TOKEN = "0x5425890298aed601595a70AB815c96711a31Bc65";
const DEST = "0x000000000000000000000000000000000000dEaD";

let guard: InMemoryFenceGuard;

function setEnv(extra: Record<string, string | undefined>) {
  vi.stubEnv("DATABASE_URL", "postgres://u:p@localhost:5432/db");
  vi.stubEnv("DESTINATION_SETTLEMENT_ADDRESS", DEST);
  vi.stubEnv("APP_MODE", "test");
  vi.stubEnv("SETTLEMENT_MODULE", "");
  for (const [k, v] of Object.entries(extra)) vi.stubEnv(k, v ?? "");
  resetEnvCache();
}

function body(transferId: string, epoch: number, patch: Record<string, unknown> = {}) {
  return {
    intent: { transferId, chainId: 43113, tokenAddress: TOKEN, destination: DEST, units: "9800000", ...patch },
    fence: { transferId, epoch },
  };
}

function call(payload: unknown, auth: string | null = `Bearer ${SECRET}`) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth !== null) headers.authorization = auth;
  return POST(
    new Request("http://x/api/internal/settlement/step", { method: "POST", headers, body: JSON.stringify(payload) }),
    undefined,
  );
}

beforeEach(() => {
  resetSettlementModuleForTests();
  guard = new InMemoryFenceGuard();
  setEnv({ INTERNAL_RPC_SECRET: SECRET });
  getSettlementModule({ fenceGuard: guard });
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
  resetSettlementModuleForTests();
});

describe("POST /api/internal/settlement/step", () => {
  it("is 404 when INTERNAL_RPC_SECRET is not set", async () => {
    setEnv({ INTERNAL_RPC_SECRET: "" });
    const res = await call(body("tr_1", 1));
    expect(res.status).toBe(404);
  });

  it("is 401 without the right bearer token", async () => {
    expect((await call(body("tr_1", 1), null)).status).toBe(401);
    expect((await call(body("tr_1", 1), "Bearer nope")).status).toBe(401);
    expect((await call(body("tr_1", 1), SECRET)).status).toBe(401);
  });

  it("returns the SettlementResult in the success envelope", async () => {
    const fence = guard.claim("tr_1");
    const res = await call(body("tr_1", fence.epoch));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toMatchObject({ kind: "PENDING", phase: "BROADCAST", txHash: expect.stringMatching(/^0x/) });
    expect(json.meta.apiVersion).toBe("v1");
    const again = await (await call(body("tr_1", fence.epoch))).json();
    expect(again.data).toMatchObject({ kind: "CONFIRMED", txHash: json.data.txHash });
  });

  it("validates the body and the configured token/destination", async () => {
    const fence = guard.claim("tr_1");
    const bad = await call(body("tr_1", fence.epoch, { units: "0" }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.fieldErrors).toHaveProperty(["intent.units"]);
    expect((await call(body("tr_1", fence.epoch, { destination: TOKEN }))).status).toBe(400);
    expect((await call({ ...body("tr_1", fence.epoch), fence: { transferId: "tr_2", epoch: 1 } })).status).toBe(400);
    expect((await call({ ...body("tr_1", fence.epoch), extra: 1 })).status).toBe(400);
  });

  it("maps a stale fence to 409 INVALID_STATE", async () => {
    const old = guard.claim("tr_1");
    guard.claim("tr_1");
    const res = await call(body("tr_1", old.epoch));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("INVALID_STATE");
  });
});

describe("isInternalRpcAuthorized()", () => {
  it("accepts only the exact bearer secret", () => {
    expect(isInternalRpcAuthorized(`Bearer ${SECRET}`, SECRET)).toBe(true);
    expect(isInternalRpcAuthorized(`Bearer ${SECRET}x`, SECRET)).toBe(false);
    expect(isInternalRpcAuthorized(`bearer ${SECRET}`, SECRET)).toBe(false);
    expect(isInternalRpcAuthorized(null, SECRET)).toBe(false);
    expect(isInternalRpcAuthorized("Bearer ", "")).toBe(false);
  });
});
