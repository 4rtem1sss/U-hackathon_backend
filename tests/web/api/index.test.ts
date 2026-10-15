import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "@/web/api/client";
import { contractQuoteExample } from "@/web/api/fixtures";
import { createRoutedClient, parseRealEndpoints } from "@/web/api/index";

function stubClient(name: string): ApiClient {
  const fn = () => vi.fn().mockResolvedValue(name);
  return {
    createSession: fn(), getRecipients: fn(), createQuote: vi.fn().mockResolvedValue(contractQuoteExample),
    createTransfer: fn(), getTransfer: fn(), simulateFunding: fn(), advance: fn(), retryPayout: fn(),
  } as unknown as ApiClient;
}

describe("endpoint routing", () => {
  it("parses the env list", () => {
    expect(parseRealEndpoints(undefined)).toEqual({ session: "mock", recipients: "mock", quotes: "mock", transfers: "mock" });
    expect(parseRealEndpoints(" Quotes, session ")).toEqual({ session: "real", recipients: "mock", quotes: "real", transfers: "mock" });
    expect(parseRealEndpoints("all")).toEqual({ session: "real", recipients: "real", quotes: "real", transfers: "real" });
  });

  it("routes each group and lets the mock remember real quotes", async () => {
    const real = stubClient("real");
    const mock = { ...stubClient("mock"), rememberQuote: vi.fn() };
    const api = createRoutedClient(parseRealEndpoints("quotes"), real, mock);
    await api.createQuote({ recipientId: "r", sourceDebitMinor: "1000" });
    expect(real.createQuote).toHaveBeenCalled();
    expect(mock.rememberQuote).toHaveBeenCalledWith(contractQuoteExample);
    expect(await api.getTransfer("t1")).toBe("mock");
  });
});

describe("endpoint mode warnings", () => {
  it("flags real quotes or transfers without a real session", async () => {
    const { endpointWarnings } = await import("@/web/api/index");
    expect(endpointWarnings(parseRealEndpoints("session,recipients,quotes"))).toEqual([]);
    expect(endpointWarnings(parseRealEndpoints("all"))).toEqual([]);
    expect(endpointWarnings(parseRealEndpoints("transfers"))).toHaveLength(1);
    expect(endpointWarnings(parseRealEndpoints("session,recipients,transfers"))).toHaveLength(1);
  });
});
