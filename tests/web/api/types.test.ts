import { describe, expect, it } from "vitest";
import { contractQuoteExample, contractSnapshotExample } from "@/web/api/fixtures";
import { envelope, ErrorEnvelopeSchema, QuoteSchema, TransferSnapshotSchema } from "@/web/api/types";

const meta = { requestId: "req_1", apiVersion: "v1", replayed: false };

describe("contract schemas", () => {
  it("accept the contract's documented quote and snapshot examples", () => {
    expect(QuoteSchema.safeParse(contractQuoteExample).success).toBe(true);
    expect(envelope(TransferSnapshotSchema).safeParse({ data: contractSnapshotExample, meta }).success).toBe(true);
  });
  it("reject decimal money strings", () => {
    expect(QuoteSchema.safeParse({ ...contractQuoteExample, feeMinor: "0.20" }).success).toBe(false);
  });
  it("accept a quote with passing simulated checks and reject any other result", () => {
    const checks = { mode: "SIMULATED", result: "PASS", reference: "check_demo_001" };
    expect(QuoteSchema.safeParse({ ...contractQuoteExample, checks }).success).toBe(true);
    expect(QuoteSchema.safeParse({ ...contractQuoteExample, checks: { ...checks, result: "REVIEW" } }).success).toBe(false);
  });
  it("reject non-https explorer URLs", () => {
    const bad = {
      ...contractSnapshotExample,
      settlement: { ...contractSnapshotExample.settlement, explorerUrl: "javascript:alert(1)" },
    };
    expect(TransferSnapshotSchema.safeParse(bad).success).toBe(false);
  });
  it("parse the contract error envelope", () => {
    const parsed = ErrorEnvelopeSchema.parse({
      error: { code: "IDEMPOTENCY_CONFLICT", message: "This request key was already used with different input.", retryable: false, fieldErrors: {} },
      meta: { requestId: "req_error_001", apiVersion: "v1" },
    });
    expect(parsed.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });
});
