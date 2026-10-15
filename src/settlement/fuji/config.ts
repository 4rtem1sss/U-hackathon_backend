import { getAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { FUJI_CHAIN_ID } from "../contract";

export const CIRCLE_FUJI_USDC = getAddress("0x5425890298aed601595a70AB815c96711a31Bc65");
export const DEFAULT_FUJI_RPC_URL = "https://api.avax-test.network/ext/bc/C/rpc";

export interface FujiConfig {
  chainId: typeof FUJI_CHAIN_ID;
  rpcUrl: string;
  tokenAddress: Address;
  destination: Address;
  privateKey: Hex;
  signerAddress: Address;
  confirmations: number;
}
export class FujiConfigurationError extends Error {
  readonly code = "FUJI_CONFIGURATION_INVALID" as const;

  constructor(message: string) {
    super(message);
    this.name = "FujiConfigurationError";
  }
}

function address(name: string, value: string | undefined): Address {
  if (!value) throw new FujiConfigurationError(`${name} is required for SETTLEMENT_MODULE=fuji.`);
  try {
    const parsed = getAddress(value);
    if (/^0x0{40}$/i.test(parsed)) throw new Error("zero");
    return parsed;
  } catch {
    throw new FujiConfigurationError(`${name} must be a non-zero 20-byte EVM address.`);
  }
}

export function parseFujiConfig(env: Record<string, string | undefined>): FujiConfig {
  const chainId = Number(env.AVALANCHE_CHAIN_ID ?? FUJI_CHAIN_ID);
  if (chainId !== FUJI_CHAIN_ID) {
    throw new FujiConfigurationError(`AVALANCHE_CHAIN_ID must be ${FUJI_CHAIN_ID}.`);
  }

  const rpcUrl = env.AVALANCHE_RPC_URL ?? DEFAULT_FUJI_RPC_URL;
  try {
    const parsed = new URL(rpcUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("protocol");
  } catch {
    throw new FujiConfigurationError("AVALANCHE_RPC_URL must be an HTTP(S) URL.");
  }

  const tokenAddress = address("USDC_TOKEN_ADDRESS", env.USDC_TOKEN_ADDRESS ?? CIRCLE_FUJI_USDC);
  if (tokenAddress.toLowerCase() !== CIRCLE_FUJI_USDC.toLowerCase()) {
    throw new FujiConfigurationError("USDC_TOKEN_ADDRESS must be Circle Test USDC on Avalanche Fuji.");
  }
  const destination = address("DESTINATION_SETTLEMENT_ADDRESS", env.DESTINATION_SETTLEMENT_ADDRESS);

  const privateKey = env.SETTLEMENT_PRIVATE_KEY;
  if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new FujiConfigurationError("SETTLEMENT_PRIVATE_KEY must be a server-only 32-byte hex private key.");
  }
  let signerAddress: Address;
  try {
    signerAddress = privateKeyToAccount(privateKey as Hex).address;
  } catch {
    throw new FujiConfigurationError("SETTLEMENT_PRIVATE_KEY is not a valid secp256k1 private key.");
  }
  if (signerAddress.toLowerCase() === destination.toLowerCase()) {
    throw new FujiConfigurationError("DESTINATION_SETTLEMENT_ADDRESS must differ from the settlement signer.");
  }

  const confirmations = Number(env.SETTLEMENT_CONFIRMATIONS ?? 2);
  if (!Number.isInteger(confirmations) || confirmations < 1 || confirmations > 64) {
    throw new FujiConfigurationError("SETTLEMENT_CONFIRMATIONS must be an integer from 1 through 64.");
  }

  return {
    chainId: FUJI_CHAIN_ID,
    rpcUrl,
    tokenAddress,
    destination,
    privateKey: privateKey as Hex,
    signerAddress,
    confirmations,
  };
}
