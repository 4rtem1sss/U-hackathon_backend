import { describe, expect, it } from "vitest";
import { SettlementIntentError } from "@/settlement/contract";
import { assertValidIntent, buildSettlementIntent } from "@/settlement/intent";

const config = {
  AVALANCHE_CHAIN_ID: 43113,
  USDC_TOKEN_ADDRESS: "0x5425890298aed601595a70AB815c96711a31Bc65",
  DESTINATION_SETTLEMENT_ADDRESS: "0x000000000000000000000000000000000000dEaD",
};

describe("buildSettlementIntent()", () => {
  it("builds the intent from config and quote units only", () => {
    const intent = buildSettlementIntent({ id: "tr_1", settlementTokenUnits: 9_800_000n }, config);
    expect(intent).toEqual({
      transferId: "tr_1",
      chainId: 43113,
      tokenAddress: "0x5425890298aed601595a70AB815c96711a31Bc65",
      destination: "0x000000000000000000000000000000000000dEaD",
      units: "9800000",
    });
    expect(() => assertValidIntent(intent)).not.toThrow();
  });

  it("keeps very large amounts exact as integer strings", () => {
    const units = 123456789012345678901234567890n;
    expect(buildSettlementIntent({ id: "tr_1", settlementTokenUnits: units }, config).units).toBe(
      "123456789012345678901234567890",
    );
  });

  it.each([0n, -1n])("rejects non-positive units (%s)", (units) => {
    expect(() => buildSettlementIntent({ id: "tr_1", settlementTokenUnits: units }, config)).toThrow(
      SettlementIntentError,
    );
  });

  it("rejects a non-bigint amount and empty id", () => {
    expect(() =>
      buildSettlementIntent({ id: "tr_1", settlementTokenUnits: 5 as unknown as bigint }, config),
    ).toThrow(/bigint/);
    expect(() => buildSettlementIntent({ id: " ", settlementTokenUnits: 1n }, config)).toThrow(/id/);
  });

  it("rejects wrong chain and bad addresses", () => {
    const tr = { id: "tr_1", settlementTokenUnits: 1n };
    expect(() => buildSettlementIntent(tr, { ...config, AVALANCHE_CHAIN_ID: 43114 })).toThrow(/43113/);
    expect(() => buildSettlementIntent(tr, { ...config, USDC_TOKEN_ADDRESS: "0x123" })).toThrow(/USDC_TOKEN_ADDRESS/);
    expect(() =>
      buildSettlementIntent(tr, { ...config, DESTINATION_SETTLEMENT_ADDRESS: "0x" + "0".repeat(40) }),
    ).toThrow(/zero address/);
    expect(() =>
      buildSettlementIntent(tr, { ...config, DESTINATION_SETTLEMENT_ADDRESS: config.USDC_TOKEN_ADDRESS.toLowerCase() }),
    ).toThrow(/token contract/);
  });
});

describe("assertValidIntent()", () => {
  const good = buildSettlementIntent({ id: "tr_1", settlementTokenUnits: 1n }, config);
  it.each([
    { units: "0" },
    { units: "01" },
    { units: "1.5" },
    { units: "-1" },
    { chainId: 1 },
    { destination: "0xnope" },
    { transferId: "" },
  ])("rejects %o", (patch) => {
    expect(() => assertValidIntent({ ...good, ...patch } as never)).toThrow(SettlementIntentError);
  });
});
