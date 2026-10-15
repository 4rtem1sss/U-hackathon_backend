import "server-only";
import { z } from "zod";
import { getEnv } from "@/config/env";
import { getRecipient, insertQuote, insertQuoteCheck, withTransaction, type QuoteCheckResult } from "@/db";
import { computeAmounts, FIXTURE_US_TH_V1, parseSourceDebitMinor } from "@/domain/pricing";
import { ApiError } from "@/lib/errors";
import { ID_PREFIX, newId } from "@/lib/ids";
import { amountString } from "@/lib/money";
import type { ServiceDeps } from "./transfers";

/** `POST /api/quotes` body. Extra fields are rejected. */
export const createQuoteBody = z.strictObject({
  recipientId: z.string().min(1).max(128),
  sourceDebitMinor: amountString,
  /** Only selects the local check simulator result. */
  demoCheckScenario: z.enum(["PASS", "REJECT", "REVIEW"]).default("PASS"),
});
export type CreateQuoteBody = z.infer<typeof createQuoteBody>;

const policy = FIXTURE_US_TH_V1;

/** Per-session limit on quote check attempts; enforced in the database. */
export const QUOTE_RATE_LIMIT = { max: 20, windowSeconds: 60 } as const;

/**
 * Price a quote for the caller's recipient. The simulated check row is always
 * committed; only a PASS check yields a quote (REJECT/REVIEW throw afterwards).
 */
export async function createQuote(input: { ownerId: string; body: CreateQuoteBody }, deps: ServiceDeps = {}) {
  const { ownerId, body } = input;
  const parsed = parseSourceDebitMinor(body.sourceDebitMinor, policy);
  if (!parsed.ok) {
    throw ApiError.invalidInput({ sourceDebitMinor: "must be between 100 and 10000 (USD 1.00 to 100.00)" });
  }
  const scenario: QuoteCheckResult = body.demoCheckScenario;

  const result = await withTransaction(
    async (client) => {
      // The window counts every check attempt (PASS/REJECT/REVIEW). The advisory
      // lock serializes one owner's requests so concurrent ones cannot all read
      // the same count and slip past the limit; it is released at commit/rollback.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [ownerId]);
      const { rows: windowRows } = await client.query<{ n: number; retry_after: string | null }>(
        `SELECT count(*)::int AS n,
                ceil(extract(epoch from (min(created_at) + make_interval(secs => $2) - now()))) AS retry_after
           FROM quote_checks
          WHERE owner_id = $1 AND created_at > now() - make_interval(secs => $2)`,
        [ownerId, QUOTE_RATE_LIMIT.windowSeconds],
      );
      if ((windowRows[0]?.n ?? 0) >= QUOTE_RATE_LIMIT.max) {
        const wait = Number(windowRows[0]?.retry_after ?? QUOTE_RATE_LIMIT.windowSeconds);
        throw new ApiError("RATE_LIMITED", {
          retryAfterSeconds: Math.min(QUOTE_RATE_LIMIT.windowSeconds, Math.max(1, wait)),
        });
      }
      const recipient = await getRecipient(client, ownerId, body.recipientId);
      if (!recipient) throw ApiError.notFound();
      if (recipient.country !== "TH" || recipient.currency !== "THB") {
        throw new ApiError("UNSUPPORTED_CORRIDOR");
      }
      const amounts = computeAmounts(parsed.value, policy);
      const check = await insertQuoteCheck(client, {
        id: newId(ID_PREFIX.quoteCheck),
        ownerId,
        recipientId: recipient.id,
        sourceDebitMinor: amounts.sourceDebitMinor,
        scenario,
        result: scenario,
        fixtureVersion: policy.version,
      });
      // Not thrown here: the check row must be committed.
      if (scenario !== "PASS") return { rejected: scenario } as const;

      const env = getEnv();
      const { rows } = await client.query<{ expires_at: Date }>(
        "SELECT now() + make_interval(secs => $1) AS expires_at",
        [env.QUOTE_TTL_SECONDS],
      );
      const expiresAt = rows[0]?.expires_at;
      if (!expiresAt) throw new Error("failed to read the database clock");
      const quote = await insertQuote(client, {
        id: newId(ID_PREFIX.quote),
        ownerId,
        recipientId: recipient.id,
        recipientSnapshot: {
          id: recipient.id,
          name: recipient.name,
          bankLabel: recipient.bankLabel,
          accountDisplay: recipient.accountDisplay,
          isSynthetic: recipient.isSynthetic,
        },
        sourceCountry: "US",
        destinationCountry: "TH",
        sourceCurrency: "USD",
        destinationCurrency: "THB",
        sourceDebitMinor: amounts.sourceDebitMinor,
        feeMinor: amounts.feeMinor,
        conversionPrincipalMinor: amounts.conversionPrincipalMinor,
        fxRateNumerator: policy.fxRateNumerator,
        fxRateDenominator: policy.fxRateDenominator,
        destinationNetMinor: amounts.destinationNetMinor,
        settlementTokenUnits: amounts.settlementTokenUnits,
        fixtureVersion: policy.version,
        chainId: env.AVALANCHE_CHAIN_ID,
        expiresAt,
        checkId: check.id,
        checkResult: "PASS",
      });
      return { quote, checkId: check.id } as const;
    },
    deps.pool ? { pool: deps.pool } : {},
  );

  if ("rejected" in result) {
    throw new ApiError(result.rejected === "REJECT" ? "CHECKS_REJECTED" : "CHECKS_REVIEW_REQUIRED");
  }
  const q = result.quote;
  return {
    id: q.id,
    recipientId: q.recipientId,
    sourceCountry: q.sourceCountry,
    destinationCountry: q.destinationCountry,
    sourceCurrency: q.sourceCurrency,
    destinationCurrency: q.destinationCurrency,
    sourceDebitMinor: q.sourceDebitMinor,
    feeMinor: q.feeMinor,
    conversionPrincipalMinor: q.conversionPrincipalMinor,
    fxRateNumerator: q.fxRateNumerator,
    fxRateDenominator: q.fxRateDenominator,
    destinationNetMinor: q.destinationNetMinor,
    settlementTokenUnits: q.settlementTokenUnits,
    fixtureVersion: q.fixtureVersion,
    createdAt: q.createdAt.toISOString(),
    expiresAt: q.expiresAt.toISOString(),
    mode: "DEMO",
    fundingSimulated: true,
    fxSimulated: true,
    payoutSimulated: true,
    settlementMode: "TESTNET",
    chainId: q.chainId,
    arrivalEstimate: null,
    checks: { mode: "SIMULATED", result: "PASS", reference: result.checkId },
  };
}
