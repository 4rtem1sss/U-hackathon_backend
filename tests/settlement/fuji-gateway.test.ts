import { describe, expect, it } from "vitest";
import { encodeFunctionData, keccak256, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { parseFujiConfig } from "@/settlement/fuji/config";
import { ViemFujiGateway } from "@/settlement/fuji/gateway";
import { FujiUnsafeTransactionError, type FujiAttemptRecord } from "@/settlement/fuji/types";

const PRIVATE_KEY = `0x${"0".repeat(63)}1` as const;
const DESTINATION = "0x000000000000000000000000000000000000dEaD";
const TRANSFER_ABI = parseAbi(["function transfer(address to, uint256 value) returns (bool)"]);

async function attempt(signedUnits: bigint, expectedUnits = signedUnits): Promise<FujiAttemptRecord> {
  const config = parseFujiConfig({
    SETTLEMENT_PRIVATE_KEY: PRIVATE_KEY,
    DESTINATION_SETTLEMENT_ADDRESS: DESTINATION,
  });
  const account = privateKeyToAccount(PRIVATE_KEY);
  const signedTx = await account.signTransaction({
    chainId: 43113,
    type: "eip1559",
    nonce: 7,
    to: config.tokenAddress,
    data: encodeFunctionData({
      abi: TRANSFER_ABI,
      functionName: "transfer",
      args: [config.destination, signedUnits],
    }),
    value: 0n,
    gas: 100_000n,
    maxFeePerGas: 30_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  });
  const now = new Date();
  return {
    attemptId: "stl_test",
    transferId: "tr_test",
    chainId: 43113,
    tokenAddress: config.tokenAddress,
    signer: config.signerAddress,
    destination: config.destination,
    units: expectedUnits.toString(10),
    nonce: "7",
    signedTx,
    txHash: keccak256(signedTx),
    phase: "PREPARED",
    receiptBlockNumber: null,
    receiptBlockHash: null,
    storedOutcome: null,
    createdFence: 1,
    createdAt: now,
    updatedAt: now,
  };
}

describe("ViemFujiGateway persisted transaction validation", () => {
  it("rejects a signed transaction whose persisted hash changed before any RPC send", async () => {
    const config = parseFujiConfig({
      SETTLEMENT_PRIVATE_KEY: PRIVATE_KEY,
      DESTINATION_SETTLEMENT_ADDRESS: DESTINATION,
    });
    const gateway = new ViemFujiGateway(config);
    const row = await attempt(1_000n);
    row.txHash = `0x${"f".repeat(64)}`;
    await expect(gateway.broadcast(row)).rejects.toBeInstanceOf(FujiUnsafeTransactionError);
  });

  it("rejects persisted bytes whose calldata amount differs from the attempt", async () => {
    const config = parseFujiConfig({
      SETTLEMENT_PRIVATE_KEY: PRIVATE_KEY,
      DESTINATION_SETTLEMENT_ADDRESS: DESTINATION,
    });
    const gateway = new ViemFujiGateway(config);
    await expect(gateway.broadcast(await attempt(1_000n, 2_000n))).rejects.toMatchObject({
      reason: "SIGNED_TRANSACTION_CALLDATA_MISMATCH",
    });
  });
});
