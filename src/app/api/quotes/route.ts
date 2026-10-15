import { ok, parseJsonBody, withHandler } from "@/lib/http";
import { allowedOrigins, createQuote, createQuoteBody, requireSession } from "@/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Create a priced quote for one of the caller's recipients, after the simulated checks. */
export const POST = withHandler(
  async (req) => {
    const session = await requireSession(req);
    const body = await parseJsonBody(req, createQuoteBody);
    return ok(await createQuote({ ownerId: session.ownerId, body }), { status: 201 });
  },
  { allowedOrigins },
);
