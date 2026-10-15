import { parseJsonBody, withHandler } from "@/lib/http";
import {
  allowedOrigins,
  mutationResponse,
  payoutRetryBody,
  requireIdempotencyKey,
  requireSession,
  retryTransferPayout,
  type IdRouteContext,
} from "@/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Deliberate retry of a known PAYOUT_FAILED (api-contract section 7). Never re-runs settlement. */
export const POST = withHandler<IdRouteContext>(
  async (req, ctx) => {
    const session = await requireSession(req);
    const idempotencyKey = requireIdempotencyKey(req);
    await parseJsonBody(req, payoutRetryBody);
    const { id } = await ctx.params;
    return mutationResponse(await retryTransferPayout({ ownerId: session.ownerId, transferId: id, idempotencyKey }));
  },
  { allowedOrigins },
);
