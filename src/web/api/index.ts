import type { ApiClient } from "./client";
import type { Quote } from "./types";

export const ENDPOINT_GROUPS = ["session", "recipients", "quotes", "transfers"] as const;
export type EndpointGroup = (typeof ENDPOINT_GROUPS)[number];
export type EndpointModes = Record<EndpointGroup, "real" | "mock">;

export interface QuoteMemory {
  rememberQuote(quote: Quote): void;
}

export function parseRealEndpoints(raw: string | undefined): EndpointModes {
  const set = new Set((raw ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
  const all = set.has("all");
  return Object.fromEntries(
    ENDPOINT_GROUPS.map((g) => [g, all || set.has(g) ? "real" : "mock"]),
  ) as EndpointModes;
}

/** Real and mock per endpoint group. Flip quotes to real before transfers. */
export function createRoutedClient(modes: EndpointModes, real: ApiClient, mock: ApiClient & QuoteMemory): ApiClient {
  const pick = (g: EndpointGroup) => (modes[g] === "real" ? real : mock);
  return {
    createSession: () => pick("session").createSession(),
    getRecipients: () => pick("recipients").getRecipients(),
    createQuote: async (input) => {
      const quote = await pick("quotes").createQuote(input);
      mock.rememberQuote(quote);
      return quote;
    },
    createTransfer: (input, key) => pick("transfers").createTransfer(input, key),
    getTransfer: (id) => pick("transfers").getTransfer(id),
    simulateFunding: (id, key) => pick("transfers").simulateFunding(id, key),
    advance: (id) => pick("transfers").advance(id),
    retryPayout: (id, key) => pick("transfers").retryPayout(id, key),
  };
}
