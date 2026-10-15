import { ok, withHandler } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Liveness probe. Does not touch the database or chain. */
export const GET = withHandler(() => ok({ status: "ok" }));
