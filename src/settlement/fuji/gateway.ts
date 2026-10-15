import {
  createPublicClient,
  decodeEventLog,
  decodeFunctionData,
  encodeFunctionData,
  formatEther,
  formatUnits,
  getAddress,
  http,
  keccak256,
  parseAbi,
  parseTransaction,
  recoverTransactionAddress,
  type Address,
  type Hash,
  type Hex,
  type TransactionSerialized,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { avalancheFuji } from "viem/chains";
import type { Issue, SettlementIntent } from "../contract";
import { CIRCLE_FUJI_USDC, type FujiConfig } from "./config";
import {
  FujiDependencyError,
  FujiNotReadyError,
  FujiUnsafeTransactionError,
  type FujiAttemptRecord,
  type FujiGateway,
  type FujiInspection,
  type PreparedFujiTransaction,
} from "./types";

const ERC20_ABI = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address owner) view returns (uint256)",
  "function transfer(address to, uint256 value) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
function issue(code: string, message: string, retryable: boolean): Issue {
  return { code, message, retryable };
}

function notFound(error: unknown): boolean {
  return error instanceof Error && /not found/i.test(`${error.name} ${error.message}`);
}

/** viem-based Fuji RPC/signing implementation. It never logs or returns the key. */
export class ViemFujiGateway implements FujiGateway {
  readonly signerAddress: Address;

  private readonly account;
  private readonly client;

  constructor(private readonly config: FujiConfig, private readonly now: () => Date = () => new Date()) {
    this.account = privateKeyToAccount(config.privateKey);
    this.signerAddress = this.account.address;
    this.client = createPublicClient({
      chain: avalancheFuji,
      transport: http(config.rpcUrl, { retryCount: 0, timeout: 8_000 }),
      cacheTime: 0,
    });
  }

  private async rpc<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof FujiNotReadyError || error instanceof FujiDependencyError) throw error;
      throw new FujiDependencyError(`Avalanche Fuji is unavailable during ${operation}.`);
    }
  }

  private async assertNetwork(): Promise<void> {
    const chainId = await this.rpc("network check", () => this.client.getChainId());
    if (chainId !== this.config.chainId) {
      throw new FujiNotReadyError(
        issue("WRONG_CHAIN", `Settlement RPC must report Avalanche Fuji chain ${this.config.chainId}.`, false),
      );
    }
  }

  private async tokenMetadata(): Promise<{ symbol: string; decimals: number }> {
    const [code, symbol, decimals] = await this.rpc("token metadata check", () =>
      Promise.all([
        this.client.getCode({ address: this.config.tokenAddress }),
        this.client.readContract({ address: this.config.tokenAddress, abi: ERC20_ABI, functionName: "symbol" }),
        this.client.readContract({ address: this.config.tokenAddress, abi: ERC20_ABI, functionName: "decimals" }),
      ]),
    );
    if (!code || code === "0x" || symbol !== "USDC" || decimals !== 6) {
      throw new FujiNotReadyError(
        issue("UNEXPECTED_TOKEN", "Configured token must be Circle Test USDC with symbol USDC and 6 decimals.", false),
      );
    }
    return { symbol, decimals };
  }

  async preflight(): Promise<{ ok: boolean; issues: Issue[] }> {
    const issues: Issue[] = [];
    try {
      await this.assertNetwork();
    } catch (error) {
      issues.push(
        error instanceof FujiNotReadyError
          ? error.issue
          : issue("RPC_UNAVAILABLE", "Avalanche Fuji RPC is unavailable.", true),
      );
      return { ok: false, issues };
    }

    try {
      await this.tokenMetadata();
    } catch (error) {
      issues.push(
        error instanceof FujiNotReadyError
          ? error.issue
          : issue("TOKEN_CHECK_UNAVAILABLE", "Circle Test USDC metadata could not be checked.", true),
      );
    }

    try {
      const [avax, usdc] = await this.rpc("wallet balance check", () =>
        Promise.all([
          this.client.getBalance({ address: this.signerAddress }),
          this.client.readContract({
            address: this.config.tokenAddress,
            abi: ERC20_ABI,
            functionName: "balanceOf",
            args: [this.signerAddress],
          }),
        ]),
      );
      if (avax === 0n) issues.push(issue("NO_TEST_AVAX", "Settlement signer has no Test AVAX for gas.", true));
      if (usdc === 0n) issues.push(issue("NO_TEST_USDC", "Settlement signer has no Circle Test USDC.", true));
    } catch {
      issues.push(issue("BALANCE_CHECK_UNAVAILABLE", "Settlement signer balances could not be checked.", true));
    }

    return { ok: issues.length === 0, issues };
  }

  async prepare(intent: SettlementIntent): Promise<PreparedFujiTransaction> {
    await this.assertNetwork();
    await this.tokenMetadata();

    const amount = BigInt(intent.units);
    const destination = getAddress(intent.destination);
    const token = getAddress(intent.tokenAddress);
    if (!sameAddress(token, this.config.tokenAddress) || !sameAddress(token, CIRCLE_FUJI_USDC)) {
      throw new FujiNotReadyError(issue("TOKEN_MISMATCH", "Settlement intent token does not match Circle Test USDC.", false));
    }
    if (!sameAddress(destination, this.config.destination)) {
      throw new FujiNotReadyError(issue("DESTINATION_MISMATCH", "Settlement intent destination is not configured.", false));
    }

    const data = encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [destination, amount] });
    const [tokenBalance, avaxBalance, nonce, fees] = await this.rpc("transaction preparation", () =>
      Promise.all([
        this.client.readContract({
          address: token,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [this.signerAddress],
        }),
        this.client.getBalance({ address: this.signerAddress }),
        this.client.getTransactionCount({ address: this.signerAddress, blockTag: "pending" }),
        this.client.estimateFeesPerGas(),
      ]),
    );

    if (tokenBalance < amount) {
      throw new FujiNotReadyError(
        issue(
          "INSUFFICIENT_TEST_USDC",
          `Settlement signer has ${formatUnits(tokenBalance, 6)} Test USDC; the persisted intent requires ${formatUnits(amount, 6)}.`,
          true,
        ),
      );
    }

    const simulation = await this.rpc("USDC transfer simulation", () =>
      this.client.simulateContract({
        account: this.account,
        address: token,
        abi: ERC20_ABI,
        functionName: "transfer",
        args: [destination, amount],
      }),
    );
    if (simulation.result !== true) {
      throw new FujiNotReadyError(issue("TRANSFER_SIMULATION_FAILED", "Test USDC transfer simulation returned false.", false));
    }

    const estimatedGas = await this.rpc("gas estimation", () =>
      this.client.estimateGas({ account: this.account, to: token, data, value: 0n }),
    );
    const gas = estimatedGas + (estimatedGas + 4n) / 5n;
    const maxFeePerGas = fees.maxFeePerGas;
    const maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
    if (maxFeePerGas === undefined || maxPriorityFeePerGas === undefined) {
      throw new FujiDependencyError("Avalanche Fuji did not provide bounded EIP-1559 fee estimates.");
    }
    const requiredAvax = gas * maxFeePerGas;
    if (avaxBalance < requiredAvax) {
      throw new FujiNotReadyError(
        issue(
          "INSUFFICIENT_TEST_AVAX",
          `Settlement signer has ${formatEther(avaxBalance)} Test AVAX but estimated gas requires ${formatEther(requiredAvax)}.`,
          true,
        ),
      );
    }

    const signedTx = await this.account.signTransaction({
      chainId: this.config.chainId,
      type: "eip1559",
      nonce,
      to: token,
      data,
      value: 0n,
      gas,
      maxFeePerGas,
      maxPriorityFeePerGas,
    });
    return {
      signer: this.signerAddress,
      nonce: nonce.toString(10),
      signedTx,
      txHash: keccak256(signedTx),
    };
  }

  private async assertPersistedTransaction(attempt: FujiAttemptRecord): Promise<void> {
    if (keccak256(attempt.signedTx).toLowerCase() !== attempt.txHash.toLowerCase()) {
      throw new FujiUnsafeTransactionError("SIGNED_TRANSACTION_HASH_MISMATCH");
    }
    try {
      const parsed = parseTransaction(attempt.signedTx);
      const signer = await recoverTransactionAddress({
        serializedTransaction: attempt.signedTx as TransactionSerialized,
      });
      if (
        parsed.chainId !== attempt.chainId ||
        parsed.nonce?.toString(10) !== attempt.nonce ||
        !parsed.to ||
        !sameAddress(parsed.to, attempt.tokenAddress) ||
        !sameAddress(signer, attempt.signer) ||
        (parsed.value ?? 0n) !== 0n
      ) {
        throw new FujiUnsafeTransactionError("SIGNED_TRANSACTION_METADATA_MISMATCH");
      }
      const decoded = decodeFunctionData({ abi: ERC20_ABI, data: parsed.data ?? "0x" });
      const [to, units] = decoded.args ?? [];
      if (
        decoded.functionName !== "transfer" ||
        typeof to !== "string" ||
        typeof units !== "bigint" ||
        !sameAddress(to, attempt.destination) ||
        units.toString(10) !== attempt.units
      ) {
        throw new FujiUnsafeTransactionError("SIGNED_TRANSACTION_CALLDATA_MISMATCH");
      }
    } catch (error) {
      if (error instanceof FujiUnsafeTransactionError) throw error;
      throw new FujiUnsafeTransactionError("SIGNED_TRANSACTION_INVALID");
    }
  }

  async broadcast(attempt: FujiAttemptRecord): Promise<Hash> {
    await this.assertPersistedTransaction(attempt);
    return this.rpc("transaction broadcast", () =>
      this.client.sendRawTransaction({ serializedTransaction: attempt.signedTx as Hex }),
    );
  }

  async inspect(attempt: FujiAttemptRecord): Promise<FujiInspection> {
    await this.assertNetwork();
    const hash = attempt.txHash as Hash;

    let transaction;
    try {
      transaction = await this.client.getTransaction({ hash });
    } catch (error) {
      if (notFound(error)) return { kind: "PENDING", issue: issue("TRANSACTION_NOT_FOUND", "Fuji has not returned the persisted transaction yet.", true) };
      throw new FujiDependencyError("Avalanche Fuji is unavailable during transaction reconciliation.");
    }

    if (
      !HASH_RE.test(transaction.hash) ||
      transaction.hash.toLowerCase() !== hash.toLowerCase() ||
      transaction.chainId !== attempt.chainId ||
      !sameAddress(transaction.from, attempt.signer) ||
      !transaction.to ||
      !sameAddress(transaction.to, attempt.tokenAddress) ||
      transaction.nonce.toString(10) !== attempt.nonce
    ) {
      return { kind: "REVIEW", reason: "TRANSACTION_METADATA_MISMATCH" };
    }

    try {
      const decoded = decodeFunctionData({ abi: ERC20_ABI, data: transaction.input });
      const [to, units] = decoded.args ?? [];
      if (
        decoded.functionName !== "transfer" ||
        typeof to !== "string" ||
        typeof units !== "bigint" ||
        !sameAddress(to, attempt.destination) ||
        units.toString(10) !== attempt.units
      ) {
        return { kind: "REVIEW", reason: "TRANSACTION_CALLDATA_MISMATCH" };
      }
    } catch {
      return { kind: "REVIEW", reason: "TRANSACTION_CALLDATA_INVALID" };
    }

    let receipt;
    try {
      receipt = await this.client.getTransactionReceipt({ hash });
    } catch (error) {
      if (notFound(error)) return { kind: "PENDING", issue: issue("RECEIPT_PENDING", "Fuji receipt is not available yet.", true) };
      throw new FujiDependencyError("Avalanche Fuji is unavailable during receipt reconciliation.");
    }

    const blockNumber = receipt.blockNumber.toString(10);
    const blockHash = receipt.blockHash;
    if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase() || !blockHash) {
      return { kind: "REVIEW", reason: "RECEIPT_METADATA_MISMATCH", blockNumber, blockHash: blockHash ?? undefined };
    }
    if (receipt.status === "reverted") {
      return { kind: "FAILED", reason: "TRANSACTION_REVERTED", blockNumber, blockHash };
    }

    const transferLogs = receipt.logs.flatMap((log) => {
      if (!sameAddress(log.address, attempt.tokenAddress)) return [];
      try {
        const decoded = decodeEventLog({ abi: ERC20_ABI, data: log.data, topics: log.topics, strict: true });
        return decoded.eventName === "Transfer" ? [decoded.args] : [];
      } catch {
        return [];
      }
    });
    if (transferLogs.length !== 1) {
      return { kind: "REVIEW", reason: "TRANSFER_EVENT_COUNT_MISMATCH", blockNumber, blockHash };
    }
    const event = transferLogs[0]!;
    if (
      !sameAddress(event.from, attempt.signer) ||
      !sameAddress(event.to, attempt.destination) ||
      event.value.toString(10) !== attempt.units
    ) {
      return { kind: "REVIEW", reason: "TRANSFER_EVENT_MISMATCH", blockNumber, blockHash };
    }

    const latestBlock = await this.rpc("confirmation check", () => this.client.getBlockNumber({ cacheTime: 0 }));
    const confirmationsBig = latestBlock >= receipt.blockNumber ? latestBlock - receipt.blockNumber + 1n : 0n;
    if (confirmationsBig < BigInt(this.config.confirmations)) {
      return { kind: "PENDING", issue: issue("AWAITING_CONFIRMATIONS", "Fuji transaction is mined and awaiting configured confirmations.", true) };
    }

    return {
      kind: "CONFIRMED",
      evidence: {
        chainId: this.config.chainId,
        blockNumber,
        blockHash,
        tokenAddress: getAddress(attempt.tokenAddress),
        from: getAddress(attempt.signer),
        to: getAddress(attempt.destination),
        units: attempt.units,
        confirmations: Number(confirmationsBig > 9_007_199_254_740_991n ? 9_007_199_254_740_991n : confirmationsBig),
        verifiedAt: this.now().toISOString(),
      },
    };
  }
}
