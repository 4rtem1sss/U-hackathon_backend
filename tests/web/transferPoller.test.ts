import { describe, expect, it, vi } from "vitest";
import { snapshotWith } from "@/web/api/fixtures";
import { ApiError } from "@/web/api/errors";
import { createMockClient, MOCK_RECIPIENT } from "@/web/api/mock";
import type { TransferSnapshot } from "@/web/api/types";
import { backoffDelay, startTransferPoller, type Schedule } from "@/web/transferPoller";

const flush = () => new Promise((r) => setTimeout(r, 0));

function manualSchedule() {
  const queue: { fn: () => void; ms: number }[] = [];
  const schedule: Schedule = (fn, ms) => {
    const item = { fn, ms };
    queue.push(item);
    return () => {
      const i = queue.indexOf(item);
      if (i >= 0) queue.splice(i, 1);
    };
  };
  return {
    schedule,
    queue,
    async runNext() {
      const item = queue.shift();
      item?.fn();
      await flush();
      return item?.ms;
    },
  };
}

describe("transfer poller", () => {
  it("backoff doubles from 2s and caps at 10s", () => {
    expect([0, 1, 2, 3, 4].map(backoffDelay)).toEqual([2000, 4000, 8000, 10000, 10000]);
  });

  it("drives the mock happy path to completion", async () => {
    const api = createMockClient();
    const quote = await api.createQuote({ recipientId: MOCK_RECIPIENT.id, sourceDebitMinor: "1000" });
    const t = await api.createTransfer({ quoteId: quote.id, purpose: "PERSONAL_REMITTANCE", demoScenario: "HAPPY_PATH" }, "k");
    await api.simulateFunding(t.id, "f");
    const seen: TransferSnapshot[] = [];
    const clock = manualSchedule();
    startTransferPoller(t.id, { api, onSnapshot: (s) => seen.push(s), onError: () => {}, schedule: clock.schedule });
    await flush();
    for (let i = 0; i < 20 && clock.queue.length; i++) await clock.runNext();
    expect(seen.at(-1)?.status).toBe("COMPLETED_SIMULATED");
    expect(clock.queue).toHaveLength(0); // stops on NONE
  });

  it("ignores snapshots older than the latest version", async () => {
    const newer = snapshotWith({ status: "SETTLED", version: 5, nextAction: "ADVANCE" });
    const older = snapshotWith({ status: "SETTLEMENT_PENDING", version: 3, nextAction: "ADVANCE" });
    const api = { getTransfer: vi.fn().mockResolvedValueOnce(newer).mockResolvedValue(older), advance: vi.fn().mockResolvedValue(older) };
    const seen: number[] = [];
    const clock = manualSchedule();
    startTransferPoller("t", { api, onSnapshot: (s) => seen.push(s.version), onError: () => {}, schedule: clock.schedule });
    await flush();
    await clock.runNext();
    expect(seen).toEqual([5]);
  });

  it("backs off on errors and resets after success", async () => {
    const done = snapshotWith({ status: "COMPLETED_SIMULATED", nextAction: "NONE" });
    const api = {
      getTransfer: vi.fn()
        .mockRejectedValueOnce(new Error("down"))
        .mockRejectedValueOnce(new Error("down"))
        .mockRejectedValueOnce(new Error("down"))
        .mockResolvedValue(done),
      advance: vi.fn(),
    };
    const errors: unknown[] = [];
    const clock = manualSchedule();
    startTransferPoller("t", { api, onSnapshot: () => {}, onError: (e) => errors.push(e), schedule: clock.schedule });
    await flush();
    const delays: number[] = [];
    for (let i = 0; i < 5 && clock.queue.length; i++) delays.push((await clock.runNext())!);
    expect(delays).toEqual([4000, 8000, 10000]);
    expect(errors).toHaveLength(3);
    expect(clock.queue).toHaveLength(0);
    expect(api.advance).not.toHaveBeenCalled();
  });

  it("stop cancels the next tick; kick restarts an idle poller", async () => {
    const pending = snapshotWith({ status: "FUNDING_PENDING", nextAction: "SIMULATE_FUNDING" });
    const api = { getTransfer: vi.fn().mockResolvedValue(pending), advance: vi.fn() };
    const clock = manualSchedule();
    const poller = startTransferPoller("t", { api, onSnapshot: () => {}, onError: () => {}, schedule: clock.schedule });
    await flush();
    expect(clock.queue).toHaveLength(0); // idle: waiting for funding
    poller.kick();
    await flush();
    expect(api.getTransfer).toHaveBeenCalledTimes(2);
    poller.stop();
    poller.kick();
    await flush();
    expect(api.getTransfer).toHaveBeenCalledTimes(2);
  });
});

describe("transfer poller error policy", () => {
  const apiError = (status: number, code: string, retryable: boolean, retryAfterSeconds: number | null = null) =>
    new ApiError({ status, code, message: code, retryable, fieldErrors: {}, requestId: "r", retryAfterSeconds });

  it("waits at least Retry-After on rate limits", async () => {
    const api = { getTransfer: vi.fn().mockRejectedValueOnce(apiError(429, "RATE_LIMITED", true, 30)), advance: vi.fn() };
    const clock = manualSchedule();
    startTransferPoller("t", { api, onSnapshot: () => {}, onError: () => {}, schedule: clock.schedule });
    await flush();
    expect(clock.queue.map((q) => q.ms)).toEqual([30000]);
  });

  it("stops on a 403 instead of retrying around it", async () => {
    const api = { getTransfer: vi.fn().mockRejectedValue(apiError(403, "DEMO_DISABLED", false)), advance: vi.fn() };
    const clock = manualSchedule();
    startTransferPoller("t", { api, onSnapshot: () => {}, onError: () => {}, schedule: clock.schedule });
    await flush();
    expect(clock.queue).toHaveLength(0);
  });
});
