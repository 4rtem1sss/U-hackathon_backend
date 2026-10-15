import { describe, expect, it } from "vitest";
import {
  DEMO_SCENARIOS,
  FUNDING_SUBSTATUSES,
  IDEMPOTENCY_SCOPES,
  NEXT_ACTIONS,
  PAYOUT_SUBSTATUSES,
  PURPOSES,
  QUOTE_STATUSES,
  SETTLEMENT_SUBSTATUSES,
  TRANSFER_STATUSES,
  isOneOf,
} from "@/domain/enums";

describe("enums", () => {
  it("match the shared vocabulary", () => {
    expect(TRANSFER_STATUSES).toHaveLength(10);
    expect(NEXT_ACTIONS).toEqual(["SIMULATE_FUNDING", "ADVANCE", "RETRY_PAYOUT", "NONE"]);
    expect(FUNDING_SUBSTATUSES).toEqual(["PENDING", "ACCEPTED", "DECLINED"]);
    expect(SETTLEMENT_SUBSTATUSES).toEqual(["NOT_STARTED", "PREPARING", "BROADCAST", "PENDING", "CONFIRMED", "FAILED", "REVIEW_REQUIRED"]);
    expect(PAYOUT_SUBSTATUSES).toEqual(["NOT_STARTED", "PENDING", "PAID", "FAILED", "UNKNOWN"]);
    expect(QUOTE_STATUSES).toEqual(["OPEN", "ACCEPTED", "EXPIRED"]);
    expect(DEMO_SCENARIOS).toEqual(["HAPPY_PATH", "FUNDING_DECLINED", "PAYOUT_FAILED"]);
    expect(PURPOSES).toEqual(["PERSONAL_REMITTANCE"]);
    expect(IDEMPOTENCY_SCOPES).toEqual(["CREATE_TRANSFER", "FUNDING", "PAYOUT_RETRY"]);
  });

  it("isOneOf narrows strings only", () => {
    expect(isOneOf(TRANSFER_STATUSES, "SETTLED")).toBe(true);
    expect(isOneOf(TRANSFER_STATUSES, "settled")).toBe(false);
    expect(isOneOf(TRANSFER_STATUSES, 1)).toBe(false);
  });
});
