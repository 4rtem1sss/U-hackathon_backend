import {
  FUJI_CHAIN_ID,
  SettlementIntentError,
  type HexAddress,
  type SettlementIntent,
} from "./contract";

/**
 * The server config fields the intent is built from. Field names match
 * `Env` in src/config/env.ts, so callers pass `getEnv()` directly.
 */
export interface SettlementIntentConfig {
  AVALANCHE_CHAIN_ID: number;
  USDC_TOKEN_ADDRESS: string;
  DESTINATION_SETTLEMENT_ADDRESS: string;
}

/** The part of a transfer the intent needs. Units come from the accepted quote snapshot. */
export interface SettlementIntentSource {
  id: string;
  /** Token base units from the accepted quote (e.g. 9800000n for 9.8 test USDC). */
  settlementTokenUnits: bigint;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS_RE = /^0x0{40}$/;

function checkAddress(name: string, value: string): HexAddress {
  if (!ADDRESS_RE.test(value)) {
    throw new SettlementIntentError(`${name} must be a 0x-prefixed 20-byte hex address.`);
  }
  if (ZERO_ADDRESS_RE.test(value)) {
    throw new SettlementIntentError(`${name} must not be the zero address.`);
  }
  return value as HexAddress;
}

/**
 * Build the immutable settlement intent for a transfer.
 *
 * Chain, token and destination come only from server config; units only from
 * the accepted quote stored on the transfer. Nothing here may come from the
 * browser. Throws {@link SettlementIntentError} on invalid config or amount.
 */
export function buildSettlementIntent(
  transfer: SettlementIntentSource,
  config: SettlementIntentConfig,
): SettlementIntent {
  if (typeof transfer.id !== "string" || transfer.id.trim() === "") {
    throw new SettlementIntentError("transfer id is required.");
  }
  if (typeof transfer.settlementTokenUnits !== "bigint") {
    throw new SettlementIntentError("settlementTokenUnits must be a bigint.");
  }
  if (transfer.settlementTokenUnits <= 0n) {
    throw new SettlementIntentError("settlementTokenUnits must be greater than zero.");
  }
  if (config.AVALANCHE_CHAIN_ID !== FUJI_CHAIN_ID) {
    throw new SettlementIntentError(`AVALANCHE_CHAIN_ID must be ${FUJI_CHAIN_ID} (Fuji).`);
  }
  const tokenAddress = checkAddress("USDC_TOKEN_ADDRESS", config.USDC_TOKEN_ADDRESS);
  const destination = checkAddress("DESTINATION_SETTLEMENT_ADDRESS", config.DESTINATION_SETTLEMENT_ADDRESS);
  if (tokenAddress.toLowerCase() === destination.toLowerCase()) {
    throw new SettlementIntentError("DESTINATION_SETTLEMENT_ADDRESS must not be the token contract.");
  }

  return {
    transferId: transfer.id,
    chainId: FUJI_CHAIN_ID,
    tokenAddress,
    destination,
    units: transfer.settlementTokenUnits.toString(10),
  };
}

const UNITS_RE = /^[1-9][0-9]*$/;

/**
 * Structural check of an intent received from elsewhere (module entry points,
 * the internal HTTP route). Does not compare against config; callers that can
 * should also compare token/destination with server config.
 */
export function assertValidIntent(intent: SettlementIntent): void {
  if (!intent || typeof intent !== "object") throw new SettlementIntentError("intent is required.");
  if (typeof intent.transferId !== "string" || intent.transferId.trim() === "") {
    throw new SettlementIntentError("intent.transferId is required.");
  }
  if (intent.chainId !== FUJI_CHAIN_ID) throw new SettlementIntentError(`intent.chainId must be ${FUJI_CHAIN_ID}.`);
  checkAddress("intent.tokenAddress", intent.tokenAddress);
  checkAddress("intent.destination", intent.destination);
  if (typeof intent.units !== "string" || !UNITS_RE.test(intent.units)) {
    throw new SettlementIntentError("intent.units must be a positive integer string.");
  }
}
