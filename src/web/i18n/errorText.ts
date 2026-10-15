import { ApiError, NetworkError } from "../api/errors";
import type { TFn } from "./translate";

export function errorText(e: unknown, t: TFn): string {
  if (e instanceof NetworkError) return t("error.network");
  if (e instanceof ApiError) {
    if (e.code === "RATE_LIMITED" || e.code === "DEMO_BUDGET_EXCEEDED") return t("error.rateLimited");
    return t("error.generic", { id: e.requestId ?? e.code });
  }
  return t("error.generic", { id: "-" });
}
