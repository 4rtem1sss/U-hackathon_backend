import { POST as fundingPOST } from "@/app/api/demo/transfers/[id]/funding/route";
import { GET as transferGET } from "@/app/api/transfers/[id]/route";
import { POST as createPOST } from "@/app/api/transfers/route";
import type { QuoteRow } from "@/db/types";
import { apiRequest, idCtx, type TestSession } from "../server/helpers";

/** Thin wrappers that call the route handlers directly with `new Request(...)`. */

export const body = (quote: QuoteRow, demoScenario = "HAPPY_PATH") => ({
  quoteId: quote.id,
  purpose: "PERSONAL_REMITTANCE",
  demoScenario,
});

export function create(session: TestSession, key: string | null, payload: unknown, origin?: string | null) {
  return createPOST(
    apiRequest("/api/transfers", {
      cookie: session.cookie,
      idempotencyKey: key,
      body: payload,
      ...(origin === undefined ? {} : { origin }),
    }),
    undefined,
  );
}

export function get(session: TestSession, id: string) {
  return transferGET(apiRequest(`/api/transfers/${id}`, { method: "GET", cookie: session.cookie }), idCtx(id));
}

export function fund(session: TestSession, id: string, key: string | null, payload: unknown = {}, origin?: string | null) {
  return fundingPOST(
    apiRequest(`/api/demo/transfers/${id}/funding`, {
      cookie: session.cookie,
      idempotencyKey: key,
      body: payload,
      ...(origin === undefined ? {} : { origin }),
    }),
    idCtx(id),
  );
}
