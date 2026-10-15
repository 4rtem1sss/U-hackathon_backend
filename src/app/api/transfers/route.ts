import { parseJsonBody, withHandler } from "@/lib/http";
import {
  allowedOrigins,
  createTransfer,
  createTransferBody,
  mutationResponse,
  requireIdempotencyKey,
  requireSession,
} from "@/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Create a transfer from the caller's open quote (api-contract section 5). */
export const POST = withHandler(
  async (req) => {
    const session = await requireSession(req);
    const idempotencyKey = requireIdempotencyKey(req);
    const body = await parseJsonBody(req, createTransferBody);
    return mutationResponse(await createTransfer({ ownerId: session.ownerId, idempotencyKey, body }));
  },
  { allowedOrigins },
);
