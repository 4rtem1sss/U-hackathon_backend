import { ok, withHandler } from "@/lib/http";
import { listSessionRecipients } from "@/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The caller's recipients (api-contract section 2). */
export const GET = withHandler(async (req) => ok({ recipients: await listSessionRecipients(req) }));
