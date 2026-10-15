import { describe, expect, it, vi } from "vitest";
import { newTransferRecord, type TransferRecord } from "@/domain";
import { completedMessage, createNtfyNotifier, formatMinor } from "@/notifications/ntfy";

function completed(): TransferRecord {
  const { record } = newTransferRecord(
    {
      id: "tr_1",
      ownerId: "own_1",
      quoteId: "quo_1",
      purpose: "PERSONAL_REMITTANCE",
      demoScenario: "HAPPY_PATH",
      recipient: { id: "rcp_1", name: "Demo Recipient", bankLabel: "Demo Thai Bank", accountDisplay: "TEST ACCOUNT 0001", isSynthetic: true },
      amounts: {
        sourceCurrency: "USD",
        destinationCurrency: "THB",
        sourceDebitMinor: 1000n,
        feeMinor: 20n,
        conversionPrincipalMinor: 980n,
        destinationNetMinor: 34300n,
        settlementTokenUnits: 9800000n,
      },
      fx: { fixtureVersion: "fixture-us-th-v1", rateNumerator: 35n, rateDenominator: 1n },
    },
    new Date("2026-10-15T15:00:00Z"),
  );
  return { ...record, settlement: { ...record.settlement, txHash: `0x${"ab".repeat(32)}` } };
}

const silent = { warn: () => {} };

describe("ntfy notifier", () => {
  it("formats minor units", () => {
    expect(formatMinor(34300n)).toBe("343.00");
    expect(formatMinor(5n)).toBe("0.05");
    expect(formatMinor(123456789n)).toBe("1,234,567.89");
  });

  it("builds a demo-labelled message with the explorer link", () => {
    const m = completedMessage(completed());
    expect(m.body).toContain("THB 343.00");
    expect(m.body).toContain("THB payout simulated");
    expect(m.click).toBe(`https://testnet.snowtrace.io/tx/0x${"ab".repeat(32)}`);
  });

  it("POSTs to <base>/<topic> with title, click and bearer token", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    const n = createNtfyNotifier({ baseUrl: "https://ntfy.example/", topic: "demo_topic", token: "tok", timeoutMs: 1000, fetch: fetchMock });
    expect(n.enabled).toBe(true);
    expect(await n.notifyCompleted(completed())).toBe("SENT");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://ntfy.example/demo_topic");
    expect(init.method).toBe("POST");
    const h = init.headers as Record<string, string>;
    expect(h.Title).toBe("Money received (demo)");
    expect(h.Authorization).toBe("Bearer tok");
    expect(h.Click).toContain("/tx/0x");
  });

  it("returns FAILED on HTTP error or network error, never throws", async () => {
    const http = createNtfyNotifier({ baseUrl: "https://n", topic: "t", timeoutMs: 1000, fetch: async () => new Response("", { status: 500 }), logger: silent });
    expect(await http.notifyCompleted(completed())).toBe("FAILED");
    const net = createNtfyNotifier({ baseUrl: "https://n", topic: "t", timeoutMs: 1000, fetch: async () => { throw new TypeError("down"); }, logger: silent });
    expect(await net.notifyCompleted(completed())).toBe("FAILED");
  });

  it("is disabled without a topic", async () => {
    const fetchMock = vi.fn();
    const n = createNtfyNotifier({ baseUrl: "https://n", topic: undefined, timeoutMs: 1000, fetch: fetchMock });
    expect(n.enabled).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
