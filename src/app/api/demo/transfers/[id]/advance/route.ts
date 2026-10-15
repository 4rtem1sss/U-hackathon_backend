import { parseJsonBody, withHandler } from "@/lib/http";
import {
  advanceBody,
  advanceTransfer,
  allowedOrigins,
  mutationResponse,
  requireSession,
  type IdRouteContext,
} from "@/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One bounded settlement / reconciliation / payout step (api-contract section 7).
 * 202 while work is pending, 200 when terminal, held or nothing to do.
 */
export const POST = withHandler<IdRouteContext>(
  async (req, ctx) => {
    const session = await requireSession(req);
    await parseJsonBody(req, advanceBody);
    const { id } = await ctx.params;
    return mutationResponse(await advanceTransfer({ ownerId: session.ownerId, transferId: id }));
  },
  { allowedOrigins },
);
