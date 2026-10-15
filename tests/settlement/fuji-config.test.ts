import { describe, expect, it } from "vitest";
import { CIRCLE_FUJI_USDC, FujiConfigurationError, parseFujiConfig } from "@/settlement/fuji/config";

const valid = {
  SETTLEMENT_PRIVATE_KEY: `0x${"0".repeat(63)}1`,
  DESTINATION_SETTLEMENT_ADDRESS: "0x000000000000000000000000000000000000dEaD",
};

describe("parseFujiConfig()", () => {
  it("pins Fuji, Circle Test USDC and bounded confirmations", () => {
    const config = parseFujiConfig(valid);
    expect(config.chainId).toBe(43113);
    expect(config.tokenAddress).toBe(CIRCLE_FUJI_USDC);
    expect(config.confirmations).toBe(2);
    expect(() => parseFujiConfig({ ...valid, AVALANCHE_CHAIN_ID: "1" })).toThrow(/43113/);
    expect(() => parseFujiConfig({ ...valid, SETTLEMENT_CONFIRMATIONS: "65" })).toThrow(/1 through 64/);
  });

  it("rejects a non-Circle token and self destination", () => {
    expect(() =>
      parseFujiConfig({ ...valid, USDC_TOKEN_ADDRESS: "0x1111111111111111111111111111111111111111" }),
    ).toThrow(/Circle Test USDC/);
    const signer = parseFujiConfig(valid).signerAddress;
    expect(() => parseFujiConfig({ ...valid, DESTINATION_SETTLEMENT_ADDRESS: signer })).toThrow(/must differ/);
  });

  it("never includes an invalid private key value in the error", () => {
    const secret = `0x${"ab".repeat(31)}`;
    let error: unknown;
    try {
      parseFujiConfig({ ...valid, SETTLEMENT_PRIVATE_KEY: secret });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(FujiConfigurationError);
    expect((error as Error).message).toContain("SETTLEMENT_PRIVATE_KEY");
    expect((error as Error).message).not.toContain(secret);
  });
});
