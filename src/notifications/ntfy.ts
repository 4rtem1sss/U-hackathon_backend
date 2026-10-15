import "server-only";
import { getEnv } from "@/config/env";
import { explorerTxUrl, type TransferRecord } from "@/domain";

/**
 * Recipient push notification over ntfy (https://docs.ntfy.sh/publish/).
 * One bounded HTTP POST; never throws. The message carries only demo data
 * (synthetic recipient, amounts, testnet hash) and says the payout is simulated.
 */

export type NotifyOutcome = "SENT" | "FAILED";

export interface Notifier {
  /** False when no topic is configured: the transfer records DISABLED and nothing is sent. */
  readonly enabled: boolean;
  notifyCompleted(record: TransferRecord): Promise<NotifyOutcome>;
}

export interface NtfyConfig {
  baseUrl: string;
  topic: string | undefined;
  token?: string | undefined;
  timeoutMs: number;
  fetch?: typeof fetch;
  logger?: Pick<Console, "warn">;
}

/** "34300" satang -> "343.00". */
export function formatMinor(minor: bigint, decimals = 2): string {
  const s = minor.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, -decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${whole}.${s.slice(-decimals)}`;
}

export function completedMessage(record: TransferRecord): { title: string; body: string; click: string | null } {
  const thb = formatMinor(record.amounts.destinationNetMinor);
  return {
    title: "Money received (demo)",
    body:
      `THB ${thb} is on its way to ${record.recipient.bankLabel} ${record.recipient.accountDisplay}. ` +
      `Demo: testnet settlement confirmed; THB payout simulated.`,
    click: record.settlement.txHash ? explorerTxUrl(record.settlement.txHash) : null,
  };
}

export function createNtfyNotifier(config: NtfyConfig): Notifier {
  const doFetch = config.fetch ?? fetch;
  const log = config.logger ?? console;
  return {
    enabled: Boolean(config.topic),
    async notifyCompleted(record) {
      if (!config.topic) return "FAILED";
      const msg = completedMessage(record);
      const headers: Record<string, string> = {
        Title: msg.title,
        Tags: "moneybag,white_check_mark",
        "Content-Type": "text/plain; charset=utf-8",
      };
      if (msg.click) headers.Click = msg.click;
      if (config.token) headers.Authorization = `Bearer ${config.token}`;
      try {
        const res = await doFetch(`${config.baseUrl.replace(/\/+$/, "")}/${encodeURIComponent(config.topic)}`, {
          method: "POST",
          headers,
          body: msg.body,
          signal: AbortSignal.timeout(config.timeoutMs),
        });
        if (res.ok) return "SENT";
        log.warn(`[notify] ntfy returned HTTP ${res.status} for ${record.id}`);
        return "FAILED";
      } catch (err) {
        log.warn(`[notify] ntfy request failed for ${record.id}: ${err instanceof Error ? err.name : "error"}`);
        return "FAILED";
      }
    },
  };
}

let cached: Notifier | undefined;

/** Process-wide notifier from env (NTFY_BASE_URL, NTFY_TOPIC, NTFY_TOKEN, NTFY_TIMEOUT_MS). */
export function getNotifier(): Notifier {
  if (!cached) {
    const env = getEnv();
    cached = createNtfyNotifier({
      baseUrl: env.NTFY_BASE_URL,
      topic: env.NTFY_TOPIC,
      token: env.NTFY_TOKEN,
      timeoutMs: env.NTFY_TIMEOUT_MS,
    });
  }
  return cached;
}

export function resetNotifierForTests(): void {
  cached = undefined;
}
