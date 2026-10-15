import type { z } from "zod";
import type { ApiClient } from "./client";
import { markDrifted } from "./drift";
import { ApiError, NetworkError } from "./errors";
import { envelope, ErrorEnvelopeSchema, QuoteSchema, RecipientSchema, RecipientsSchema, SessionSchema, TransferSnapshotSchema, type Session } from "./types";

const SESSION_PATH = "/api/demo/session";

export type SchemaMismatchReporter = (endpoint: string, issues: string[]) => void;

export function createRealClient(
  opts: { fetchImpl?: typeof fetch; onSchemaMismatch?: SchemaMismatchReporter } = {},
): ApiClient {
  const doFetch: typeof fetch = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const report = opts.onSchemaMismatch ?? (() => {});
  // One session request at a time: the provider and any concurrent 401 retries share it.
  let sessionInFlight: Promise<Session> | null = null;
  const ensureSession = (): Promise<Session> =>
    (sessionInFlight ??= request("POST", SESSION_PATH, SessionSchema, {}, undefined, true).finally(() => {
      sessionInFlight = null;
    }));

  async function request<S extends z.ZodType>(
    method: "GET" | "POST",
    path: string,
    schema: S,
    body?: unknown,
    idempotencyKey?: string,
    retried = false,
  ): Promise<z.infer<S>> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (method === "POST") headers["Content-Type"] = "application/json";
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

    let res: Response;
    try {
      res = await doFetch(path, {
        method,
        headers,
        credentials: "same-origin",
        body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
      });
    } catch (cause) {
      throw new NetworkError(path, cause);
    }

    const json: unknown = await res.json().catch(() => null);

    if (!res.ok) {
      const parsed = ErrorEnvelopeSchema.safeParse(json);
      const e = parsed.success ? parsed.data.error : null;
      const error = new ApiError({
        status: res.status,
        code: e?.code ?? "INTERNAL_ERROR",
        message: e?.message ?? `HTTP ${res.status}`,
        retryable: e?.retryable ?? res.status >= 500,
        fieldErrors: e?.fieldErrors ?? {},
        requestId: parsed.success ? (parsed.data.meta?.requestId ?? null) : null,
        retryAfterSeconds: Number(res.headers.get("Retry-After")) || null,
      });
      if (error.code === "UNAUTHENTICATED" && !retried && path !== SESSION_PATH) {
        await ensureSession();
        return request(method, path, schema, body, idempotencyKey, true);
      }
      throw error;
    }

    const parsed = envelope(schema).safeParse(json);
    if (!parsed.success) {
      report(`${method} ${path}`, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
      const data = (json as { data?: unknown } | null)?.data;
      if (typeof data === "object" && data !== null) markDrifted(data);
      return data as z.infer<S>;
    }
    return (parsed.data as { data: z.infer<S> }).data;
  }

  const t = (id: string) => encodeURIComponent(id);

  return {
    createSession: () => ensureSession(),
    getRecipients: async () => (await request("GET", "/api/recipients", RecipientsSchema)).recipients,
    createRecipient: (input) => request("POST", "/api/recipients", RecipientSchema, input),
    createQuote: (input) => request("POST", "/api/quotes", QuoteSchema, input),
    createTransfer: (input, key) => request("POST", "/api/transfers", TransferSnapshotSchema, input, key),
    getTransfer: (id) => request("GET", `/api/transfers/${t(id)}`, TransferSnapshotSchema),
    simulateFunding: (id, key) => request("POST", `/api/demo/transfers/${t(id)}/funding`, TransferSnapshotSchema, {}, key),
    advance: (id) => request("POST", `/api/demo/transfers/${t(id)}/advance`, TransferSnapshotSchema, {}),
    retryPayout: (id, key) => request("POST", `/api/demo/transfers/${t(id)}/payout-retry`, TransferSnapshotSchema, {}, key),
  };
}
