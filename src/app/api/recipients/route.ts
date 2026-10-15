import { newRecipientBody } from "@/domain/recipients";
import { ok, parseJsonBody, withHandler } from "@/lib/http";
import { allowedOrigins, createSessionRecipient, listSessionRecipients, requireSession } from "@/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The caller's recipients (api-contract section 3). */
export const GET = withHandler(async (req) => ok({ recipients: await listSessionRecipients(req) }));

/** Add a synthetic recipient typed in during the demo (api-contract section 3). */
export const POST = withHandler(
  async (req) => {
    const session = await requireSession(req);
    const body = await parseJsonBody(req, newRecipientBody);
    return ok(await createSessionRecipient({ ownerId: session.ownerId, body }), { status: 201 });
  },
  { allowedOrigins },
);
