/**
 * API error codes and their HTTP mapping (api-contract.md section 9).
 * `retryable` describes whether repeating/reconciling the *same* safe action may help;
 * it never authorizes a fresh payment.
 */
export const ERROR_CODES = {
  INVALID_INPUT: { status: 400, retryable: false, message: "The request input is invalid." },
  IDEMPOTENCY_KEY_REQUIRED: {
    status: 400,
    retryable: false,
    message: "An Idempotency-Key header is required for this request.",
  },
  UNAUTHENTICATED: { status: 401, retryable: false, message: "A valid demo session is required." },
  ORIGIN_NOT_ALLOWED: { status: 403, retryable: false, message: "This request origin is not allowed." },
  DEMO_DISABLED: { status: 403, retryable: false, message: "The demo is currently disabled." },
  NOT_FOUND: { status: 404, retryable: false, message: "The requested record was not found." },
  IDEMPOTENCY_CONFLICT: {
    status: 409,
    retryable: false,
    message: "This request key was already used with different input.",
  },
  QUOTE_ALREADY_ACCEPTED: {
    status: 409,
    retryable: false,
    message: "This quote has already been accepted.",
  },
  INVALID_STATE: {
    status: 409,
    retryable: false,
    message: "This action is not allowed in the transfer's current state.",
  },
  QUOTE_EXPIRED: { status: 410, retryable: false, message: "This quote has expired." },
  UNSUPPORTED_CORRIDOR: {
    status: 422,
    retryable: false,
    message: "Only the US to Thailand demo corridor is supported.",
  },
  CHECKS_REJECTED: {
    status: 422,
    retryable: false,
    message: "Simulated checks rejected this transfer.",
  },
  CHECKS_REVIEW_REQUIRED: {
    status: 422,
    retryable: false,
    message: "Held for review (simulated). No quote was issued.",
  },
  RATE_LIMITED: { status: 429, retryable: true, message: "Too many requests. Please slow down." },
  DEMO_BUDGET_EXCEEDED: {
    status: 429,
    retryable: true,
    message: "The demo budget has been reached. Please try again later.",
  },
  INTERNAL_ERROR: { status: 500, retryable: false, message: "An unexpected error occurred." },
  DEPENDENCY_UNAVAILABLE: {
    status: 503,
    retryable: true,
    message: "A dependency is temporarily unavailable.",
  },
} as const satisfies Record<string, { status: number; retryable: boolean; message: string }>;

export type ErrorCode = keyof typeof ERROR_CODES;

export type FieldErrors = Record<string, string>;

export interface ApiErrorOptions {
  message?: string;
  fieldErrors?: FieldErrors;
  /** Override the table default (rarely needed). */
  retryable?: boolean;
  /** Seconds, sent as a `Retry-After` header (429/503). */
  retryAfterSeconds?: number;
  cause?: unknown;
}

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly fieldErrors: FieldErrors;
  readonly retryAfterSeconds?: number;

  constructor(code: ErrorCode, options: ApiErrorOptions = {}) {
    const def = ERROR_CODES[code];
    super(options.message ?? def.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ApiError";
    this.code = code;
    this.status = def.status;
    this.retryable = options.retryable ?? def.retryable;
    this.fieldErrors = options.fieldErrors ?? {};
    if (options.retryAfterSeconds !== undefined) this.retryAfterSeconds = options.retryAfterSeconds;
  }

  static invalidInput(fieldErrors: FieldErrors, message?: string): ApiError {
    return new ApiError("INVALID_INPUT", { fieldErrors, ...(message ? { message } : {}) });
  }

  static notFound(): ApiError {
    return new ApiError("NOT_FOUND");
  }
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}
