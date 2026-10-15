import { AsyncLocalStorage } from "node:async_hooks";
import { ZodError, type z } from "zod";
import { ApiError, type ErrorCode, type FieldErrors } from "./errors";
import { newRequestId } from "./ids";

export { ApiError, ERROR_CODES, isApiError, type ErrorCode, type FieldErrors } from "./errors";

export const API_VERSION = "v1" as const;
export const REQUEST_ID_HEADER = "x-request-id";

// ---------------------------------------------------------------------------
// Request context (request ID) propagated through async calls by withHandler.
// ---------------------------------------------------------------------------

export interface RequestContext {
  requestId: string;
}

const requestContext = new AsyncLocalStorage<RequestContext>();

/** Current request ID inside `withHandler`; a fresh one outside of it. */
export function currentRequestId(): string {
  return requestContext.getStore()?.requestId ?? newRequestId();
}

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return requestContext.run(ctx, fn);
}

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

export interface SuccessEnvelope<T> {
  data: T;
  meta: { requestId: string; apiVersion: typeof API_VERSION; replayed: boolean };
}

export interface ErrorEnvelope {
  error: { code: ErrorCode; message: string; retryable: boolean; fieldErrors: FieldErrors };
  meta: { requestId: string; apiVersion: typeof API_VERSION };
}

export interface OkOptions {
  status?: number;
  replayed?: boolean;
  requestId?: string;
  headers?: HeadersInit;
}

const NO_STORE = "no-store";

function jsonResponse(body: unknown, status: number, requestId: string, headers?: HeadersInit): Response {
  const h = new Headers(headers);
  h.set("content-type", "application/json; charset=utf-8");
  h.set("cache-control", NO_STORE);
  h.set(REQUEST_ID_HEADER, requestId);
  return new Response(JSON.stringify(body), { status, headers: h });
}

export function successEnvelope<T>(data: T, opts: { requestId: string; replayed?: boolean }): SuccessEnvelope<T> {
  return {
    data,
    meta: { requestId: opts.requestId, apiVersion: API_VERSION, replayed: opts.replayed ?? false },
  };
}

/** `{ data, meta: { requestId, apiVersion: "v1", replayed } }` with status 200 by default. */
export function ok<T>(data: T, opts: OkOptions = {}): Response {
  const requestId = opts.requestId ?? currentRequestId();
  return jsonResponse(
    successEnvelope(data, { requestId, replayed: opts.replayed ?? false }),
    opts.status ?? 200,
    requestId,
    opts.headers,
  );
}

/** Map any thrown value to an ApiError. Unknown errors become INTERNAL_ERROR (no details). */
export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof ZodError) return ApiError.invalidInput(zodFieldErrors(err));
  return new ApiError("INTERNAL_ERROR", { cause: err });
}

export function errorEnvelope(err: ApiError, requestId: string): ErrorEnvelope {
  return {
    error: {
      code: err.code,
      message: err.message,
      retryable: err.retryable,
      fieldErrors: err.fieldErrors,
    },
    meta: { requestId, apiVersion: API_VERSION },
  };
}

/** Build the error response. Never includes stack traces or internal messages. */
export function errorResponse(err: unknown, opts: { requestId?: string } = {}): Response {
  const requestId = opts.requestId ?? currentRequestId();
  const apiErr = toApiError(err);
  const headers = new Headers();
  if (apiErr.retryAfterSeconds !== undefined) {
    headers.set("retry-after", String(Math.max(0, Math.ceil(apiErr.retryAfterSeconds))));
  }
  return jsonResponse(errorEnvelope(apiErr, requestId), apiErr.status, requestId, headers);
}

/** Flatten zod issues to `{ "field.path": "message" }` (first message per field). */
export function zodFieldErrors(err: ZodError): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of err.issues) {
    const key = issue.path.length > 0 ? issue.path.map(String).join(".") : "_";
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

/** Parse a JSON body against a schema. Invalid JSON or schema mismatch -> 400 INVALID_INPUT. */
export async function parseJsonBody<S extends z.ZodType>(req: Request, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    const text = await req.text();
    raw = text.trim() === "" ? {} : JSON.parse(text);
  } catch {
    throw ApiError.invalidInput({ _: "Request body must be valid JSON." });
  }
  const result = schema.safeParse(raw);
  if (!result.success) throw ApiError.invalidInput(zodFieldErrors(result.error));
  return result.data;
}

// ---------------------------------------------------------------------------
// Same-origin check for browser mutations
// ---------------------------------------------------------------------------

function normalizeOrigin(value: string): string | null {
  try {
    const u = new URL(value);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * True when the request's `Origin` header matches one of `allowedOrigins` or the
 * request's own host (`x-forwarded-host` / `host`). A missing or `null` Origin is
 * rejected: browser mutations must carry an allowed same-origin `Origin`.
 */
export function isOriginAllowed(req: Request, allowedOrigins: readonly string[]): boolean {
  const originHeader = req.headers.get("origin");
  if (!originHeader || originHeader === "null") return false;
  const origin = normalizeOrigin(originHeader);
  if (!origin) return false;

  for (const allowed of allowedOrigins) {
    if (normalizeOrigin(allowed) === origin) return true;
  }

  const forwardedHost = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = (forwardedHost || req.headers.get("host") || "").toLowerCase();
  if (host === "") return false;
  return new URL(origin).host === host;
}

/** Throw 403 ORIGIN_NOT_ALLOWED unless `isOriginAllowed`. */
export function assertSameOrigin(req: Request, allowedOrigins: readonly string[]): void {
  if (!isOriginAllowed(req, allowedOrigins)) throw new ApiError("ORIGIN_NOT_ALLOWED");
}

// ---------------------------------------------------------------------------
// Route handler wrapper
// ---------------------------------------------------------------------------

export type Logger = Pick<Console, "error">;

export interface HandlerOptions {
  /**
   * For mutations: enforce the same-origin check. Pass a function so config is
   * read lazily per request (e.g. `() => getEnv().ALLOWED_ORIGINS`).
   */
  allowedOrigins?: () => readonly string[];
  logger?: Logger;
}

export type RouteHandler<Ctx> = (req: Request, ctx: Ctx, rc: RequestContext) => Promise<Response> | Response;

/**
 * Wrap a Next.js route handler: assigns a request ID (available via
 * `currentRequestId()` and the 3rd argument), optionally enforces the
 * same-origin check, and converts any thrown error into the error envelope.
 */
export function withHandler<Ctx = unknown>(
  handler: RouteHandler<Ctx>,
  options: HandlerOptions = {},
): (req: Request, ctx: Ctx) => Promise<Response> {
  const logger = options.logger ?? console;
  return async (req, ctx) => {
    const rc: RequestContext = { requestId: newRequestId() };
    return runWithRequestContext(rc, async () => {
      try {
        if (options.allowedOrigins) assertSameOrigin(req, options.allowedOrigins());
        const res = await handler(req, ctx, rc);
        if (!res.headers.has(REQUEST_ID_HEADER)) {
          try {
            res.headers.set(REQUEST_ID_HEADER, rc.requestId);
          } catch {
            // immutable headers (e.g. Response.redirect); ignore
          }
        }
        return res;
      } catch (err) {
        const apiErr = toApiError(err);
        if (apiErr.code === "INTERNAL_ERROR") {
          // Server-side log only; the response never contains the stack or message.
          logger.error(`[${rc.requestId}] unhandled error`, err);
        }
        return errorResponse(apiErr, { requestId: rc.requestId });
      }
    });
  };
}
