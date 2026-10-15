import { parseJsonBody, withHandler } from "@/lib/http";
import {
  allowedOrigins,
  fundingBody,
  mutationResponse,
  requireIdempotencyKey,
  requireSession,
  simulateTransferFunding,
  type IdRouteContext,
} from "@/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Simulate funding for a FUNDING_PENDING transfer (api-contract section 7). */
export const POST = withHandler<IdRouteContext>(
  async (req, ctx, rc) => {
    const session = await requireSession(req);
    const idempotencyKey = requireIdempotencyKey(req);
    await parseJsonBody(req, fundingBody);
    const { id } = await ctx.params;
    return mutationResponse(
      await simulateTransferFunding({
        ownerId: session.ownerId,
        transferId: id,
        idempotencyKey,
        requestId: rc.requestId,
      }),
    );
  },
  { allowedOrigins },
);
