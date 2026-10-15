import { ok, withHandler } from "@/lib/http";
import { allowedOrigins, createOrResumeSession, isSecureRequest, sessionCookieHeader } from "@/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Create or resume the anonymous demo session (api-contract section 2). The token only travels in the cookie. */
export const POST = withHandler(
  async (req) => {
    const { created, session, token } = await createOrResumeSession(req);
    const body = { sessionId: session.sessionId, mode: "DEMO", expiresAt: session.expiresAt.toISOString() };
    if (!created || token === undefined) return ok(body);
    return ok(body, {
      headers: { "set-cookie": sessionCookieHeader(token, session.expiresAt, isSecureRequest(req)) },
    });
  },
  { allowedOrigins },
);
