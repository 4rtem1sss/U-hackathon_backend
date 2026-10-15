/**
 * Optional internal HTTP form of SettlementModule.step (plan §4.5). Only for
 * when part 4 runs as a separate service; the default is the in-process call.
 *
 * - Disabled (404) unless INTERNAL_RPC_SECRET is set.
 * - `Authorization: Bearer <INTERNAL_RPC_SECRET>`, compared in constant time.
 * - Body `{ intent, fence }`; token and destination must equal server config.
 * - Response: the SettlementResult in the standard success envelope.
 *   A stale fence → 409 INVALID_STATE; a thrown step → 503 DEPENDENCY_UNAVAILABLE
 *   (caller treats it exactly like a thrown in-process step).
 */
import { z } from "zod";
import { getEnv } from "@/config/env";
import { ApiError, ok, parseJsonBody, withHandler } from "@/lib/http";
import { FUJI_CHAIN_ID, SettlementIntentError, isStaleFenceError } from "@/settlement/contract";
import { getSettlementModule } from "@/settlement";
import { isInternalRpcAuthorized } from "@/settlement/internal-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const hexAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 20-byte hex address");

const bodySchema = z.strictObject({
  intent: z.strictObject({
    transferId: z.string().min(1).max(128),
    chainId: z.literal(FUJI_CHAIN_ID),
    tokenAddress: hexAddress.transform((v) => v as `0x${string}`),
    destination: hexAddress.transform((v) => v as `0x${string}`),
    units: z.string().regex(/^[1-9][0-9]{0,37}$/, "must be a positive integer string"),
  }),
  fence: z.strictObject({
    transferId: z.string().min(1).max(128),
    epoch: z.number().int().nonnegative(),
  }),
});

export const POST = withHandler(async (req) => {
  const env = getEnv();
  const secret = env.INTERNAL_RPC_SECRET;
  if (!secret) throw ApiError.notFound();
  if (!isInternalRpcAuthorized(req.headers.get("authorization"), secret)) throw new ApiError("UNAUTHENTICATED");

  const { intent, fence } = await parseJsonBody(req, bodySchema);
  if (fence.transferId !== intent.transferId) {
    throw ApiError.invalidInput({ "fence.transferId": "must equal intent.transferId" });
  }
  if (intent.tokenAddress.toLowerCase() !== env.USDC_TOKEN_ADDRESS.toLowerCase()) {
    throw ApiError.invalidInput({ "intent.tokenAddress": "does not match server configuration" });
  }
  if (intent.destination.toLowerCase() !== env.DESTINATION_SETTLEMENT_ADDRESS.toLowerCase()) {
    throw ApiError.invalidInput({ "intent.destination": "does not match server configuration" });
  }

  const settlement = getSettlementModule();
  let result;
  try {
    result = await settlement.step(intent, fence);
  } catch (err) {
    if (isStaleFenceError(err)) {
      throw new ApiError("INVALID_STATE", { message: "The settlement fence is stale.", cause: err });
    }
    if (err instanceof SettlementIntentError) {
      throw ApiError.invalidInput({ intent: err.message });
    }
    console.error("[internal settlement step] step threw", err);
    throw new ApiError("DEPENDENCY_UNAVAILABLE", { cause: err });
  }
  return ok(result);
});
