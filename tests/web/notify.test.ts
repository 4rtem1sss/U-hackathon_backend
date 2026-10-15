import { describe, expect, it, vi } from "vitest";
import { snapshotWith } from "@/web/api/fixtures";
import { notificationText, ntfyNotifier } from "@/web/notify";

describe("ntfy notifier", () => {
  it("does nothing without a topic", async () => {
    const fetchImpl = vi.fn();
    expect(await ntfyNotifier(undefined, fetchImpl)(snapshotWith({ status: "COMPLETED_SIMULATED" }))).toBe("DISABLED");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts an honest message to the topic", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const s = snapshotWith({ status: "COMPLETED_SIMULATED", settlement: { mode: "MOCK" } });
    expect(await ntfyNotifier("centme-abc", fetchImpl)(s)).toBe("SENT");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://ntfy.sh/centme-abc");
    expect(init.body).toBe("[MOCK] Demo Recipient received ฿343.00 · THB payout simulated.");
  });

  it("describes real testnet settlement without the mock prefix", () => {
    expect(notificationText(snapshotWith({ status: "COMPLETED_SIMULATED" }))).toBe(
      "Demo Recipient received ฿343.00 · USDC settled on Avalanche Fuji · THB payout simulated.",
    );
  });

  it("reports FAILED instead of throwing", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("offline"));
    expect(await ntfyNotifier("t", fetchImpl)(snapshotWith({ status: "COMPLETED_SIMULATED" }))).toBe("FAILED");
  });
});
