import { getPool } from "@/db";
import { ok, withHandler } from "@/lib/http";
import { loadSnapshot, requireSession, type IdRouteContext } from "@/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Owner-scoped transfer snapshot (api-contract section 6). Pure read. */
export const GET = withHandler<IdRouteContext>(async (req, ctx) => {
  const session = await requireSession(req);
  const { id } = await ctx.params;
  return ok(await loadSnapshot(getPool(), session.ownerId, id));
});
