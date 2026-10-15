import { describe, expect, it } from "vitest";
import { snapshotWith } from "@/web/api/fixtures";
import type { TransferSnapshot } from "@/web/api/types";
import { stepTime, toView } from "@/web/status";

const states = (s: TransferSnapshot) => toView(s).steps.map((x) => x.state);

describe("toView", () => {
  it("funding pending offers Finish payment only when the server asks for funding", () => {
    const v = toView(snapshotWith({ status: "FUNDING_PENDING", nextAction: "SIMULATE_FUNDING", funding: { status: "PENDING" } }));
    expect(v.steps.map((x) => x.state)).toEqual(["active", "todo", "todo", "todo"]);
    expect(v.action).toBe("FINISH_PAYMENT");
    expect(toView(snapshotWith({ status: "FUNDING_PENDING", nextAction: "NONE" })).action).toBeNull();
  });

  it.each([
    ["FUNDED_SIMULATED", ["done", "done", "active", "todo"], null, "track.headline.sending"],
    ["SETTLEMENT_PENDING", ["done", "done", "active", "todo"], null, "track.headline.sending"],
    ["SETTLED", ["done", "done", "done", "active"], null, "track.headline.sending"],
    ["PAYOUT_PENDING", ["done", "done", "done", "active"], null, "track.headline.sending"],
    ["FUNDING_FAILED", ["failed", "todo", "todo", "todo"], "START_OVER", "track.headline.fundingFailed"],
    ["SETTLEMENT_FAILED", ["done", "done", "failed", "todo"], "START_OVER", "track.headline.settlementFailed"],
    ["PAYOUT_FAILED", ["done", "done", "done", "failed"], "RETRY_PAYOUT", "track.headline.payoutFailed"],
    ["COMPLETED_SIMULATED", ["done", "done", "done", "done"], "SEND_ANOTHER", "track.headline.done"],
  ] as const)("%s", (status, expected, action, headline) => {
    const v = toView(snapshotWith({ status }));
    expect(v.steps.map((x) => x.state)).toEqual(expected);
    expect(v.action).toBe(action);
    expect(v.headlineKey).toBe(headline);
    expect(v.showReceipt).toBe(status === "COMPLETED_SIMULATED");
  });

  it("review required holds the first unfinished leg and keeps verified settlement", () => {
    const s = snapshotWith({ status: "REVIEW_REQUIRED", settlement: { status: "CONFIRMED" }, payout: { status: "UNKNOWN" } });
    expect(states(s)).toEqual(["done", "done", "done", "hold"]);
    expect(toView(s).headlineKey).toBe("track.headline.hold");
  });

  it("unknown status renders a hold instead of crashing", () => {
    const s = { ...snapshotWith({ status: "SETTLEMENT_PENDING" }), status: "SOMETHING_NEW" } as unknown as TransferSnapshot;
    expect(states(s)).toEqual(["done", "done", "hold", "todo"]);
    expect(toView(s).action).toBeNull();
  });

  it("tags legs honestly and swaps the settlement label in mock mode", () => {
    const real = toView(snapshotWith({ status: "SETTLED" })).steps;
    expect(real.map((x) => x.tag)).toEqual(["SIMULATED", "SIMULATED", "TESTNET", "SIMULATED"]);
    expect(real[2]?.labelKey).toBe("step.settlement");
    const mock = toView(snapshotWith({ status: "SETTLED", settlement: { mode: "MOCK" } })).steps;
    expect(mock[2]?.tag).toBe("MOCK");
    expect(mock[2]?.labelKey).toBe("step.settlementMock");
  });

  it("surfaces lastIssue and the notification flag", () => {
    const v = toView(snapshotWith({
      status: "SETTLEMENT_PENDING",
      lastIssue: { code: "RPC_TIMEOUT", message: "Settlement outcome is not confirmed yet.", retryable: true },
      notification: { channel: "NTFY", status: "SENT", sentAt: "2026-10-15T15:02:00Z" },
    }));
    expect(v.issueMessage).toBe("Settlement outcome is not confirmed yet.");
    expect(v.notified).toBe(true);
    expect(toView(snapshotWith({ status: "SETTLED" })).notified).toBe(false);
  });
});

describe("stepTime", () => {
  it("returns the event time that completed a step", () => {
    const s = snapshotWith({ status: "SETTLEMENT_PENDING" });
    expect(stepTime(s, "funding")).toBe("2026-10-15T15:01:02Z");
    expect(stepTime(s, "settlement")).toBeNull();
  });
});
