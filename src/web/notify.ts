import type { TransferSnapshot } from "./api/types";
import { formatMinor } from "./money";

export type NotifyResult = "SENT" | "FAILED" | "DISABLED";
export type Notifier = (s: TransferSnapshot) => Promise<NotifyResult>;

export function notificationText(s: TransferSnapshot): string {
  const amount = formatMinor(s.amounts.destinationNetMinor, "THB");
  return s.settlement.mode === "MOCK"
    ? `[MOCK] ${s.recipient.name} received ${amount} · THB payout simulated.`
    : `${s.recipient.name} received ${amount} · USDC settled on Avalanche Fuji · THB payout simulated.`;
}

/** Browser-side push for mock mode. Synthetic data only: ntfy.sh topics are public. */
export function ntfyNotifier(
  topic: string | undefined,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): Notifier {
  return async (s) => {
    if (!topic) return "DISABLED";
    try {
      const res = await fetchImpl(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
        method: "POST",
        body: notificationText(s),
        headers: { Title: "CentMe", Tags: "moneybag" },
      });
      return res.ok ? "SENT" : "FAILED";
    } catch {
      return "FAILED";
    }
  };
}
