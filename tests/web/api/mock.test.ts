import { describe, expect, it, vi } from "vitest";
import { memoryStore } from "@/web/storage";
import { ApiError } from "@/web/api/errors";
import { createMockClient, MOCK_RECIPIENT } from "@/web/api/mock";
import type { DemoScenario, TransferSnapshot } from "@/web/api/types";

async function start(scenario: DemoScenario = "HAPPY_PATH", opts: Parameters<typeof createMockClient>[0] = {}) {
  const api = createMockClient(opts);
  const quote = await api.createQuote({ recipientId: MOCK_RECIPIENT.id, sourceDebitMinor: "1000" });
  const created = await api.createTransfer({ quoteId: quote.id, purpose: "PERSONAL_REMITTANCE", demoScenario: scenario }, "k-create");
  return { api, quote, created };
}

async function runToRest(api: ReturnType<typeof createMockClient>, id: string) {
  const seen: TransferSnapshot[] = [];
  let s = await api.getTransfer(id);
  for (let i = 0; i < 20 && s.nextAction === "ADVANCE"; i++) {
    s = await api.advance(id);
    seen.push(s);
  }
  return { last: s, seen };
}

describe("mock backend", () => {
  it("quotes with fixture arithmetic and mock settlement mode", async () => {
    const { quote } = await start();
    expect(quote).toMatchObject({ feeMinor: "20", destinationNetMinor: "34300", settlementMode: "MOCK" });
  });

  it("runs the happy path in contract order and notifies once", async () => {
    const notify = vi.fn().mockResolvedValue("SENT");
    const { api, created } = await start("HAPPY_PATH", { notify });
    expect(created).toMatchObject({ status: "FUNDING_PENDING", version: 1, nextAction: "SIMULATE_FUNDING" });
    await api.simulateFunding(created.id, "k-fund");
    const { last, seen } = await runToRest(api, created.id);
    expect(seen.map((s) => s.status)).toEqual([
      "SETTLEMENT_PENDING", "SETTLEMENT_PENDING", "SETTLED", "PAYOUT_PENDING", "COMPLETED_SIMULATED",
    ]);
    expect(last.settlement).toMatchObject({ mode: "MOCK", status: "CONFIRMED", explorerUrl: null });
    expect(last.settlement.txHash).toMatch(/^mock-0x[0-9a-f]{64}$/);
    expect(last.receipt).not.toBeNull();
    expect(last.notification).toMatchObject({ channel: "NTFY", status: "SENT" });
    expect(last.notification.sentAt).not.toBeNull();
    expect(notify).toHaveBeenCalledTimes(1);
    const versions = seen.map((s) => s.version);
    expect([...versions].sort((a, b) => a - b)).toEqual(versions);
  });

  it("stops at FUNDING_FAILED when funding is declined", async () => {
    const { api, created } = await start("FUNDING_DECLINED");
    const s = await api.simulateFunding(created.id, "k-fund");
    expect(s).toMatchObject({ status: "FUNDING_FAILED", nextAction: "NONE", funding: { status: "DECLINED" } });
    expect(s.settlement.txHash).toBeNull();
  });

  it("fails payout once, then retry completes without a new settlement", async () => {
    const { api, created } = await start("PAYOUT_FAILED");
    await api.simulateFunding(created.id, "k-fund");
    const failed = (await runToRest(api, created.id)).last;
    expect(failed).toMatchObject({ status: "PAYOUT_FAILED", nextAction: "RETRY_PAYOUT" });
    const hash = failed.settlement.txHash;
    await api.retryPayout(created.id, "k-retry");
    const done = (await runToRest(api, created.id)).last;
    expect(done.status).toBe("COMPLETED_SIMULATED");
    expect(done.settlement.txHash).toBe(hash);
  });

  it("replays createTransfer with the same key", async () => {
    const { api, quote, created } = await start();
    const again = await api.createTransfer({ quoteId: quote.id, purpose: "PERSONAL_REMITTANCE", demoScenario: "HAPPY_PATH" }, "k-create");
    expect(again.id).toBe(created.id);
    const conflict = await api
      .createTransfer({ quoteId: quote.id, purpose: "PERSONAL_REMITTANCE", demoScenario: "PAYOUT_FAILED" }, "k-create")
      .catch((e) => e);
    expect(conflict).toBeInstanceOf(ApiError);
    expect(conflict.code).toBe("IDEMPOTENCY_CONFLICT");
    const otherKey = await api
      .createTransfer({ quoteId: quote.id, purpose: "PERSONAL_REMITTANCE", demoScenario: "HAPPY_PATH" }, "k-other")
      .catch((e) => e);
    expect(otherKey.code).toBe("QUOTE_ALREADY_ACCEPTED");
  });

  it("replays simulateFunding with the same key", async () => {
    const { api, created } = await start();
    const first = await api.simulateFunding(created.id, "k-fund");
    const second = await api.simulateFunding(created.id, "k-fund");
    expect(second.version).toBe(first.version);
    expect(second.funding.reference).toBe(first.funding.reference);
    const newKey = await api.simulateFunding(created.id, "k-fund-2").catch((e) => e);
    expect(newKey.code).toBe("INVALID_STATE");
  });

  it("rejects an expired quote with 410", async () => {
    let now = new Date("2026-10-16T10:00:00Z");
    const api = createMockClient({ now: () => now });
    const quote = await api.createQuote({ recipientId: MOCK_RECIPIENT.id, sourceDebitMinor: "1000" });
    now = new Date("2026-10-16T10:05:01Z");
    const err = await api
      .createTransfer({ quoteId: quote.id, purpose: "PERSONAL_REMITTANCE", demoScenario: "HAPPY_PATH" }, "k")
      .catch((e) => e);
    expect(err).toMatchObject({ status: 410, code: "QUOTE_EXPIRED" });
  });

  it("runs simulated checks on quotes", async () => {
    const api = createMockClient();
    const pass = await api.createQuote({ recipientId: MOCK_RECIPIENT.id, sourceDebitMinor: "1000" });
    expect(pass.checks).toMatchObject({ mode: "SIMULATED", result: "PASS" });
    const rejected = await api
      .createQuote({ recipientId: MOCK_RECIPIENT.id, sourceDebitMinor: "1000", demoCheckScenario: "REJECT" })
      .catch((e) => e);
    expect(rejected).toMatchObject({ status: 422, code: "CHECKS_REJECTED", retryable: false });
    const review = await api
      .createQuote({ recipientId: MOCK_RECIPIENT.id, sourceDebitMinor: "1000", demoCheckScenario: "REVIEW" })
      .catch((e) => e);
    expect(review).toMatchObject({ status: 422, code: "CHECKS_REVIEW_REQUIRED", retryable: false });
  });

  it("rejects out-of-range amounts with field errors", async () => {
    const api = createMockClient();
    const err = await api.createQuote({ recipientId: MOCK_RECIPIENT.id, sourceDebitMinor: "10001" }).catch((e) => e);
    expect(err).toMatchObject({ status: 400, code: "INVALID_INPUT" });
    expect(err.fieldErrors.sourceDebitMinor).toBeTruthy();
  });

  it("persists across clients sharing storage and resets", async () => {
    const storage = memoryStore();
    const { created } = await start("HAPPY_PATH", { storage });
    const reopened = createMockClient({ storage });
    expect((await reopened.getTransfer(created.id)).id).toBe(created.id);
    reopened.reset();
    const gone = await createMockClient({ storage }).getTransfer(created.id).catch((e) => e);
    expect(gone.code).toBe("NOT_FOUND");
  });

  it("creates recipients with last-4 display and lists them after the seeded one", async () => {
    const api = createMockClient();
    const r = await api.createRecipient({ name: " Somchai ", bankCode: "SCB", accountNumber: "123-4-56789-0" });
    expect(r).toMatchObject({ name: "Somchai", bankLabel: "SCB", accountDisplay: "••7890", isSynthetic: true });
    expect((await api.getRecipients()).map((x) => x.id)).toEqual([MOCK_RECIPIENT.id, r.id]);
  });

  it("rejects invalid recipient input with per-field errors", async () => {
    const api = createMockClient();
    const e = await api.createRecipient({ name: "", bankCode: "SCB", accountNumber: "12" }).catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e.code).toBe("INVALID_INPUT");
    expect(Object.keys(e.fieldErrors).sort()).toEqual(["accountNumber", "name"]);
  });

  it("caps recipients at the limit", async () => {
    const api = createMockClient();
    for (let i = 0; i < 9; i++) await api.createRecipient({ name: "A", bankCode: "SCB", accountNumber: "1234567890" });
    const e = await api.createRecipient({ name: "A", bankCode: "SCB", accountNumber: "1234567890" }).catch((x) => x);
    expect(e.code).toBe("RECIPIENT_LIMIT");
  });

  it("puts the quoted recipient on the transfer snapshot", async () => {
    const api = createMockClient();
    const r = await api.createRecipient({ name: "Nong Fon", bankCode: "KTB", accountNumber: "9876543210" });
    const quote = await api.createQuote({ recipientId: r.id, sourceDebitMinor: "1000" });
    const t = await api.createTransfer({ quoteId: quote.id, purpose: "PERSONAL_REMITTANCE", demoScenario: "HAPPY_PATH" }, "k-r");
    expect(t.recipient).toMatchObject({ id: r.id, name: "Nong Fon", bankLabel: "Krungthai", accountDisplay: "••3210" });
  });

  it("never reuses a recipient id after reset", async () => {
    const api = createMockClient();
    const input = { name: "A", bankCode: "SCB" as const, accountNumber: "1234567890" };
    const before = await api.createRecipient(input);
    api.reset();
    const after = await api.createRecipient(input);
    expect(after.id).not.toBe(before.id);
    expect(after.id).toMatch(/^rcp_mock_/);
  });

  it("forgets created recipients on reset", async () => {
    const api = createMockClient();
    await api.createRecipient({ name: "A", bankCode: "SCB", accountNumber: "1234567890" });
    api.reset();
    expect(await api.getRecipients()).toHaveLength(1);
  });
});
