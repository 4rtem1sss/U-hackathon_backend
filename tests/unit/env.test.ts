import { afterEach, describe, expect, it } from "vitest";
import { EnvValidationError, getEnv, parseEnv, resetEnvCache } from "@/config/env";

const base = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  DESTINATION_SETTLEMENT_ADDRESS: "0x000000000000000000000000000000000000dEaD",
};

describe("parseEnv()", () => {
  it("applies defaults", () => {
    const env = parseEnv(base);
    expect(env.APP_MODE).toBe("development");
    expect(env.AVALANCHE_CHAIN_ID).toBe(43113);
    expect(env.USDC_TOKEN_ADDRESS).toBe("0x5425890298aed601595a70AB815c96711a31Bc65");
    expect(env.QUOTE_TTL_SECONDS).toBe(300);
    expect(env.SETTLEMENT_CONFIRMATIONS).toBe(2);
    expect(env.ALLOWED_ORIGINS).toEqual([]);
    expect(env.SETTLEMENT_PRIVATE_KEY).toBeUndefined();
    expect(env.INTERNAL_RPC_SECRET).toBeUndefined();
  });

  it("parses lists, numbers and empty optionals", () => {
    const env = parseEnv({
      ...base,
      ALLOWED_ORIGINS: "https://a.example, https://b.example/ ,",
      QUOTE_TTL_SECONDS: "60",
      SETTLEMENT_PRIVATE_KEY: "",
      INTERNAL_RPC_SECRET: "",
    });
    expect(env.ALLOWED_ORIGINS).toEqual(["https://a.example", "https://b.example"]);
    expect(env.QUOTE_TTL_SECONDS).toBe(60);
    expect(env.SETTLEMENT_PRIVATE_KEY).toBeUndefined();
  });

  it("reports names, not secret values", () => {
    const key = "0x" + "ab".repeat(31); // too short
    try {
      parseEnv({ ...base, DATABASE_URL: "mysql://x", SETTLEMENT_PRIVATE_KEY: key });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(EnvValidationError);
      const msg = (e as Error).message;
      expect(msg).toContain("DATABASE_URL");
      expect(msg).toContain("SETTLEMENT_PRIVATE_KEY");
      expect(msg).not.toContain(key);
    }
  });

  it("requires DATABASE_URL and DESTINATION_SETTLEMENT_ADDRESS", () => {
    expect(() => parseEnv({})).toThrow(/DATABASE_URL[\s\S]*DESTINATION_SETTLEMENT_ADDRESS/);
  });
});

describe("getEnv()", () => {
  afterEach(() => resetEnvCache());

  it("is lazy and cached", () => {
    const saved = { ...process.env };
    try {
      Object.assign(process.env, base);
      const a = getEnv();
      expect(getEnv()).toBe(a);
    } finally {
      process.env = saved;
    }
  });
});
