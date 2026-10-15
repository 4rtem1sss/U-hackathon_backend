export type ApiErrorInit = {
  status: number;
  code: string;
  message: string;
  retryable: boolean;
  fieldErrors: Record<string, string>;
  requestId: string | null;
  retryAfterSeconds: number | null;
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly fieldErrors: Record<string, string>;
  readonly requestId: string | null;
  readonly retryAfterSeconds: number | null;

  constructor(init: ApiErrorInit) {
    super(init.message);
    this.name = "ApiError";
    this.status = init.status;
    this.code = init.code;
    this.retryable = init.retryable;
    this.fieldErrors = init.fieldErrors;
    this.requestId = init.requestId;
    this.retryAfterSeconds = init.retryAfterSeconds;
  }
}

export class NetworkError extends Error {
  readonly path: string;
  constructor(path: string, cause?: unknown) {
    super(`Network request failed: ${path}`, { cause });
    this.name = "NetworkError";
    this.path = path;
  }
}

export function isApiError(e: unknown, code?: string): e is ApiError {
  return e instanceof ApiError && (code === undefined || e.code === code);
}
