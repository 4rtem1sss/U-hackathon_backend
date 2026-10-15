import type { DemoScenario, Quote, Recipient, Session, TransferSnapshot } from "./types";

/** `demoCheckScenario` is sent only when not PASS, so a backend without the field still accepts the default request. */
export type CreateQuoteInput = { recipientId: string; sourceDebitMinor: string; demoCheckScenario?: "REJECT" | "REVIEW" };
export type CreateTransferInput = { quoteId: string; purpose: "PERSONAL_REMITTANCE"; demoScenario: DemoScenario };

export interface ApiClient {
  createSession(): Promise<Session>;
  getRecipients(): Promise<Recipient[]>;
  createQuote(input: CreateQuoteInput): Promise<Quote>;
  createTransfer(input: CreateTransferInput, idempotencyKey: string): Promise<TransferSnapshot>;
  getTransfer(id: string): Promise<TransferSnapshot>;
  simulateFunding(id: string, idempotencyKey: string): Promise<TransferSnapshot>;
  advance(id: string): Promise<TransferSnapshot>;
  retryPayout(id: string, idempotencyKey: string): Promise<TransferSnapshot>;
}
