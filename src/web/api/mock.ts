import { accountDisplayFromNumber, bankLabel, newRecipientBody, RECIPIENT_LIMIT } from "@/domain/recipients";
import { estimateQuote, FIXTURE } from "../money";
import type { NotifyResult, Notifier } from "../notify";
import { memoryStore, type KeyValueStore } from "../storage";
import type { ApiClient } from "./client";
import { ApiError } from "./errors";
import type { QuoteMemory } from "./index";
import type { Quote, Recipient, TransferSnapshot, TransferStatus } from "./types";

const STORAGE_KEY = "centme:mock:v1";
const QUOTE_TTL_MS = 300_000;
const TOKEN_ADDRESS = "0x5425890298aed601595a70AB815c96711a31Bc65";

export const MOCK_RECIPIENT: Recipient = {
  id: "rcp_mock_th_001", // real ids are opaque rcp_<uuid>; the UI must use whatever getRecipients returns
  name: "Demo Recipient",
  country: "TH",
  currency: "THB",
  bankLabel: "Demo Thai Bank",
  accountDisplay: "TEST ACCOUNT 0001",
  isSynthetic: true,
};

type QuoteRecord = { quote: Quote; state: "OPEN" | "ACCEPTED" };
type KeyRecord = { fingerprint: string; transferId: string };
type TransferRecord = { snapshot: TransferSnapshot; payoutAttempts: number };
type MockState = {
  counter: number;
  recipients: Recipient[];
  quotes: Record<string, QuoteRecord>;
  transfers: Record<string, TransferRecord>;
  keys: Record<string, KeyRecord>;
};

export type MockClient = ApiClient & QuoteMemory & { reset(): void };

const emptyState = (): MockState => ({ counter: 0, recipients: [], quotes: {}, transfers: {}, keys: {} });

function mockHash(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return "mock-0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function createMockClient(
  opts: { storage?: KeyValueStore; now?: () => Date; notify?: Notifier; delayMs?: number } = {},
): MockClient {
  const storage = opts.storage ?? memoryStore();
  const now = opts.now ?? (() => new Date());
  const notify: Notifier = opts.notify ?? (async () => "DISABLED");
  const delayMs = opts.delayMs ?? 0;

  let state: MockState = (() => {
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (raw) return { ...emptyState(), ...(JSON.parse(raw) as Partial<MockState>) };
    } catch {
      // corrupt mock data: start fresh
    }
    return emptyState();
  })();

  const save = () => storage.setItem(STORAGE_KEY, JSON.stringify(state));
  const nextId = (prefix: string) => `${prefix}_${++state.counter}`;
  const iso = () => now().toISOString();
  const clone = <T>(v: T): T => structuredClone(v);
  const fail = (status: number, code: string, message: string, fieldErrors: Record<string, string> = {}) =>
    new ApiError({ status, code, message, retryable: false, fieldErrors, requestId: `mock_req_${state.counter}`, retryAfterSeconds: null });

  function record(id: string): TransferRecord {
    const r = state.transfers[id];
    if (!r) throw fail(404, "NOT_FOUND", "Transfer not found.");
    return r;
  }

  const allRecipients = (): Recipient[] => [MOCK_RECIPIENT, ...state.recipients];
  const findRecipient = (id: string) => allRecipients().find((r) => r.id === id) ?? null;

  function transition(r: TransferRecord, status: TransferStatus, patch: Partial<TransferSnapshot>) {
    const s = r.snapshot;
    const at = iso();
    r.snapshot = {
      ...s,
      ...patch,
      status,
      version: s.version + 1,
      updatedAt: at,
      events: [...s.events, { sequence: s.events.length + 1, status, createdAt: at }],
    };
    save();
  }

  /** Snapshot changes without a status change still bump the version. */
  function patchOnly(r: TransferRecord, patch: Partial<TransferSnapshot>) {
    r.snapshot = { ...r.snapshot, ...patch, version: r.snapshot.version + 1, updatedAt: iso() };
    save();
  }

  function replay(key: string, fingerprint: string): TransferSnapshot | null {
    const k = state.keys[key];
    if (!k) return null;
    if (k.fingerprint !== fingerprint) throw fail(409, "IDEMPOTENCY_CONFLICT", "This request key was already used with different input.");
    return clone(record(k.transferId).snapshot);
  }

  return {
    async createSession() {
      return { sessionId: "mock_session", mode: "DEMO", expiresAt: new Date(now().getTime() + 86_400_000).toISOString() };
    },

    async getRecipients() {
      return clone(allRecipients());
    },

    async createRecipient(input) {
      const parsed = newRecipientBody.safeParse(input);
      if (!parsed.success) {
        const fieldErrors: Record<string, string> = {};
        for (const issue of parsed.error.issues) fieldErrors[String(issue.path[0] ?? "_")] ??= issue.message;
        throw fail(400, "INVALID_INPUT", "The request input is invalid.", fieldErrors);
      }
      if (allRecipients().length >= RECIPIENT_LIMIT) {
        throw fail(409, "RECIPIENT_LIMIT", "This demo session already has the maximum number of recipients.");
      }
      const r: Recipient = {
        id: nextId("rcp_mock"),
        name: parsed.data.name,
        country: "TH",
        currency: "THB",
        bankLabel: bankLabel(parsed.data.bankCode),
        accountDisplay: accountDisplayFromNumber(parsed.data.accountNumber),
        isSynthetic: true,
      };
      state.recipients.push(r);
      save();
      return clone(r);
    },

    async createQuote({ recipientId, sourceDebitMinor, demoCheckScenario }) {
      if (!findRecipient(recipientId)) throw fail(404, "NOT_FOUND", "Recipient not found.");
      if (!/^[1-9]\d*$/.test(sourceDebitMinor)) {
        throw fail(400, "INVALID_INPUT", "Invalid amount.", { sourceDebitMinor: "Use whole cents." });
      }
      const debit = BigInt(sourceDebitMinor);
      if (debit < FIXTURE.minDebitMinor || debit > FIXTURE.maxDebitMinor) {
        throw fail(400, "INVALID_INPUT", "Amount out of range.", { sourceDebitMinor: "USD 1.00 to 100.00 only." });
      }
      // Simulated checks run before a quote exists; a blocked check stores no quote.
      if (demoCheckScenario === "REJECT") throw fail(422, "CHECKS_REJECTED", "Simulated checks rejected this transfer.");
      if (demoCheckScenario === "REVIEW") throw fail(422, "CHECKS_REVIEW_REQUIRED", "Held for review (simulated). No quote issued.");
      const created = now();
      const quote: Quote = {
        id: nextId("mock_quote"),
        recipientId,
        sourceCountry: "US",
        destinationCountry: "TH",
        sourceCurrency: "USD",
        destinationCurrency: "THB",
        ...estimateQuote(sourceDebitMinor),
        fxRateNumerator: FIXTURE.rateNumerator.toString(),
        fxRateDenominator: FIXTURE.rateDenominator.toString(),
        fixtureVersion: FIXTURE.version,
        createdAt: created.toISOString(),
        expiresAt: new Date(created.getTime() + QUOTE_TTL_MS).toISOString(),
        mode: "DEMO",
        fundingSimulated: true,
        fxSimulated: true,
        payoutSimulated: true,
        settlementMode: "MOCK",
        chainId: 43113,
        arrivalEstimate: null,
        checks: { mode: "SIMULATED", result: "PASS", reference: nextId("mock_check") },
      };
      state.quotes[quote.id] = { quote, state: "OPEN" };
      save();
      return clone(quote);
    },

    rememberQuote(quote) {
      if (state.quotes[quote.id]) return;
      state.quotes[quote.id] = { quote: clone(quote), state: "OPEN" };
      save();
    },

    async createTransfer(input, key) {
      const fingerprint = `${input.quoteId}|${input.purpose}|${input.demoScenario}`;
      const replayed = replay(`create:${key}`, fingerprint);
      if (replayed) return replayed;
      const q = state.quotes[input.quoteId];
      if (!q) throw fail(404, "NOT_FOUND", "Quote not found.");
      if (q.state === "ACCEPTED") throw fail(409, "QUOTE_ALREADY_ACCEPTED", "This quote was already used.");
      if (now().getTime() > Date.parse(q.quote.expiresAt)) throw fail(410, "QUOTE_EXPIRED", "This quote has expired.");

      const at = iso();
      const id = nextId("mock_transfer");
      const snapshot: TransferSnapshot = {
        id,
        quoteId: q.quote.id,
        status: "FUNDING_PENDING",
        version: 1,
        mode: "DEMO",
        purpose: input.purpose,
        demoScenario: input.demoScenario,
        recipient: (() => {
          // A quote from the real backend (mixed modes) has a recipient the mock never saw.
          const r = findRecipient(q.quote.recipientId) ?? MOCK_RECIPIENT;
          return { id: r.id, name: r.name, bankLabel: r.bankLabel, accountDisplay: r.accountDisplay, isSynthetic: true };
        })(),
        amounts: {
          sourceCurrency: "USD",
          destinationCurrency: "THB",
          sourceDebitMinor: q.quote.sourceDebitMinor,
          feeMinor: q.quote.feeMinor,
          conversionPrincipalMinor: q.quote.conversionPrincipalMinor,
          destinationNetMinor: q.quote.destinationNetMinor,
          settlementTokenUnits: q.quote.settlementTokenUnits,
        },
        funding: { mode: "SIMULATED", status: "PENDING", reference: null },
        fx: {
          mode: "SIMULATED",
          fixtureVersion: q.quote.fixtureVersion,
          rateNumerator: q.quote.fxRateNumerator,
          rateDenominator: q.quote.fxRateDenominator,
        },
        settlement: {
          mode: "MOCK",
          status: "NOT_STARTED",
          chainId: 43113,
          tokenSymbol: "USDC",
          tokenAddress: TOKEN_ADDRESS,
          tokenDecimals: 6,
          txHash: null,
          explorerUrl: null,
          verifiedAt: null,
        },
        payout: { mode: "SIMULATED", status: "NOT_STARTED", reference: null },
        notification: { channel: "NTFY", status: "NOT_STARTED", sentAt: null },
        events: [{ sequence: 1, status: "FUNDING_PENDING", createdAt: at }],
        lastIssue: null,
        nextAction: "SIMULATE_FUNDING",
        receipt: null,
        createdAt: at,
        updatedAt: at,
      };
      q.state = "ACCEPTED";
      state.transfers[id] = { snapshot, payoutAttempts: 0 };
      state.keys[`create:${key}`] = { fingerprint, transferId: id };
      save();
      return clone(snapshot);
    },

    async getTransfer(id) {
      return clone(record(id).snapshot);
    },

    async simulateFunding(id, key) {
      const replayed = replay(`funding:${key}`, id);
      if (replayed) return replayed;
      const r = record(id);
      if (r.snapshot.status !== "FUNDING_PENDING") throw fail(409, "INVALID_STATE", "Funding was already processed.");
      const reference = nextId("mock_funding");
      if (r.snapshot.demoScenario === "FUNDING_DECLINED") {
        transition(r, "FUNDING_FAILED", { funding: { mode: "SIMULATED", status: "DECLINED", reference }, nextAction: "NONE" });
      } else {
        transition(r, "FUNDED_SIMULATED", { funding: { mode: "SIMULATED", status: "ACCEPTED", reference }, nextAction: "ADVANCE" });
      }
      state.keys[`funding:${key}`] = { fingerprint: id, transferId: id };
      save();
      return clone(r.snapshot);
    },

    async advance(id) {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const r = record(id);
      const s = r.snapshot;
      switch (s.status) {
        case "FUNDED_SIMULATED":
          transition(r, "SETTLEMENT_PENDING", { settlement: { ...s.settlement, status: "PREPARING" }, nextAction: "ADVANCE" });
          break;
        case "SETTLEMENT_PENDING":
          if (s.settlement.status === "PREPARING") {
            patchOnly(r, { settlement: { ...s.settlement, status: "BROADCAST", txHash: mockHash() } });
          } else {
            transition(r, "SETTLED", { settlement: { ...s.settlement, status: "CONFIRMED", verifiedAt: iso() }, nextAction: "ADVANCE" });
          }
          break;
        case "SETTLED":
          r.payoutAttempts += 1;
          transition(r, "PAYOUT_PENDING", {
            payout: { mode: "SIMULATED", status: "PENDING", reference: nextId("mock_payout") },
            nextAction: "ADVANCE",
          });
          break;
        case "PAYOUT_PENDING":
          if (s.demoScenario === "PAYOUT_FAILED" && r.payoutAttempts === 1) {
            transition(r, "PAYOUT_FAILED", { payout: { ...s.payout, status: "FAILED" }, nextAction: "RETRY_PAYOUT" });
          } else {
            transition(r, "COMPLETED_SIMULATED", {
              payout: { ...s.payout, status: "PAID" },
              nextAction: "NONE",
              receipt: { id: nextId("mock_receipt"), issuedAt: iso(), summary: "Demo completed: mock settlement; THB payout simulated." },
            });
            const result: NotifyResult = await notify(clone(r.snapshot)).catch(() => "FAILED" as const);
            patchOnly(r, { notification: { channel: "NTFY", status: result, sentAt: result === "SENT" ? iso() : null } });
          }
          break;
        default:
          break;
      }
      return clone(r.snapshot);
    },

    async retryPayout(id, key) {
      const replayed = replay(`payout:${key}`, id);
      if (replayed) return replayed;
      const r = record(id);
      if (r.snapshot.status !== "PAYOUT_FAILED") throw fail(409, "INVALID_STATE", "Payout is not in a failed state.");
      r.payoutAttempts += 1;
      transition(r, "PAYOUT_PENDING", {
        payout: { mode: "SIMULATED", status: "PENDING", reference: nextId("mock_payout") },
        nextAction: "ADVANCE",
      });
      state.keys[`payout:${key}`] = { fingerprint: id, transferId: id };
      save();
      return clone(r.snapshot);
    },

    reset() {
      state = emptyState();
      storage.removeItem(STORAGE_KEY);
    },
  };
}
