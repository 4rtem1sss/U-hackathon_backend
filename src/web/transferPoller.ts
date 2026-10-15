import type { ApiClient } from "./api/client";
import type { TransferSnapshot } from "./api/types";

export type Schedule = (fn: () => void, ms: number) => () => void;

const defaultSchedule: Schedule = (fn, ms) => {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
};

export const BASE_DELAY_MS = 2000;
export const MAX_DELAY_MS = 10000;

export function backoffDelay(failures: number): number {
  return Math.min(BASE_DELAY_MS * 2 ** failures, MAX_DELAY_MS);
}

export type TransferPoller = { stop(): void; kick(): void; accept(s: TransferSnapshot): void };

/**
 * Reads the transfer, calls advance only while nextAction is ADVANCE, one request in flight.
 * Goes idle on any other nextAction; kick() resumes after a user action (funding, payout retry).
 */
export function startTransferPoller(
  id: string,
  deps: {
    api: Pick<ApiClient, "getTransfer" | "advance">;
    onSnapshot(s: TransferSnapshot): void;
    onError(e: unknown): void;
    schedule?: Schedule;
  },
): TransferPoller {
  const schedule = deps.schedule ?? defaultSchedule;
  let latest: TransferSnapshot | null = null;
  let stopped = false;
  let running = false;
  let failures = 0;
  let cancel: (() => void) | null = null;

  function accept(s: TransferSnapshot) {
    if (latest && s.version < latest.version) return;
    latest = s;
    deps.onSnapshot(s);
  }

  async function tick() {
    cancel = null;
    if (stopped || running) return;
    running = true;
    try {
      accept(await deps.api.getTransfer(id));
      if (latest?.nextAction === "ADVANCE") accept(await deps.api.advance(id));
      failures = 0;
    } catch (e) {
      failures += 1;
      deps.onError(e);
    } finally {
      running = false;
    }
    if (stopped) return;
    if (failures > 0 || latest?.nextAction === "ADVANCE") cancel = schedule(tick, backoffDelay(failures));
  }

  void tick();

  return {
    stop() {
      stopped = true;
      cancel?.();
      cancel = null;
    },
    kick() {
      if (stopped) return;
      cancel?.();
      cancel = null;
      void tick();
    },
    accept,
  };
}
