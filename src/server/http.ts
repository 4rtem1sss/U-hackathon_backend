import "server-only";
import { getEnv } from "@/config/env";
import { ok } from "@/lib/http";
import type { MutationResult } from "./transfers";

/** Same-origin allow-list for mutation routes (`withHandler({ allowedOrigins })`). */
export const allowedOrigins = (): readonly string[] => getEnv().ALLOWED_ORIGINS;

/** Next.js 16 dynamic route context for `[id]` segments. */
export interface IdRouteContext {
  params: Promise<{ id: string }>;
}

/** Envelope a service mutation result (status + meta.replayed). */
export function mutationResponse(result: MutationResult): Response {
  return ok(result.snapshot, { status: result.status, replayed: result.replayed });
}
