import { z } from "zod";

export const TRANSFER_STATUSES = [
  "FUNDING_PENDING", "FUNDED_SIMULATED", "FUNDING_FAILED", "SETTLEMENT_PENDING", "SETTLED",
  "SETTLEMENT_FAILED", "PAYOUT_PENDING", "PAYOUT_FAILED", "REVIEW_REQUIRED", "COMPLETED_SIMULATED",
] as const;
export const NEXT_ACTIONS = ["SIMULATE_FUNDING", "ADVANCE", "RETRY_PAYOUT", "NONE"] as const;
export const DEMO_SCENARIOS = ["HAPPY_PATH", "FUNDING_DECLINED", "PAYOUT_FAILED"] as const;
export const CHECK_SCENARIOS = ["PASS", "REJECT", "REVIEW"] as const;
export const FUNDING_STATUSES = ["PENDING", "ACCEPTED", "DECLINED"] as const;
export const SETTLEMENT_STATUSES = ["NOT_STARTED", "PREPARING", "BROADCAST", "PENDING", "CONFIRMED", "FAILED", "REVIEW_REQUIRED"] as const;
export const PAYOUT_STATUSES = ["NOT_STARTED", "PENDING", "PAID", "FAILED", "UNKNOWN"] as const;
export const NOTIFICATION_STATUSES = ["NOT_STARTED", "PENDING", "SENT", "FAILED", "DISABLED"] as const;

const minor = z.string().regex(/^(0|[1-9]\d*)$/, "expected an integer string");
const iso = z.string().min(1);

export const MetaSchema = z.object({ requestId: z.string(), apiVersion: z.string(), replayed: z.boolean().optional() });

export const SessionSchema = z.object({ sessionId: z.string(), mode: z.literal("DEMO"), expiresAt: iso });

export const RecipientSchema = z.object({
  id: z.string(), name: z.string(), country: z.string(), currency: z.string(),
  bankLabel: z.string(), accountDisplay: z.string(), isSynthetic: z.boolean(),
});
export const RecipientsSchema = z.object({ recipients: z.array(RecipientSchema) });

export const QuoteSchema = z.object({
  id: z.string(), recipientId: z.string(),
  sourceCountry: z.literal("US"), destinationCountry: z.literal("TH"),
  sourceCurrency: z.literal("USD"), destinationCurrency: z.literal("THB"),
  sourceDebitMinor: minor, feeMinor: minor, conversionPrincipalMinor: minor,
  fxRateNumerator: minor, fxRateDenominator: minor, destinationNetMinor: minor, settlementTokenUnits: minor,
  fixtureVersion: z.string(), createdAt: iso, expiresAt: iso, mode: z.literal("DEMO"),
  fundingSimulated: z.boolean(), fxSimulated: z.boolean(), payoutSimulated: z.boolean(),
  settlementMode: z.enum(["TESTNET", "MOCK"]), chainId: z.number().int(), arrivalEstimate: z.string().nullable(),
  checks: z.object({ mode: z.literal("SIMULATED"), result: z.literal("PASS"), reference: z.string() }).optional(),
});

export const TransferSnapshotSchema = z.object({
  id: z.string(),
  quoteId: z.string(),
  status: z.enum(TRANSFER_STATUSES),
  version: z.number().int(),
  mode: z.literal("DEMO"),
  purpose: z.string(),
  demoScenario: z.enum(DEMO_SCENARIOS),
  recipient: z.object({
    id: z.string(), name: z.string(), bankLabel: z.string(), accountDisplay: z.string(), isSynthetic: z.boolean(),
  }),
  amounts: z.object({
    sourceCurrency: z.literal("USD"), destinationCurrency: z.literal("THB"),
    sourceDebitMinor: minor, feeMinor: minor, conversionPrincipalMinor: minor,
    destinationNetMinor: minor, settlementTokenUnits: minor,
  }),
  funding: z.object({ mode: z.literal("SIMULATED"), status: z.enum(FUNDING_STATUSES), reference: z.string().nullable() }),
  fx: z.object({ mode: z.literal("SIMULATED"), fixtureVersion: z.string(), rateNumerator: minor, rateDenominator: minor }),
  settlement: z.object({
    mode: z.enum(["TESTNET", "MOCK"]),
    status: z.enum(SETTLEMENT_STATUSES),
    chainId: z.number().int(),
    tokenSymbol: z.string(),
    tokenAddress: z.string(),
    tokenDecimals: z.number().int(),
    txHash: z.string().nullable(),
    explorerUrl: z.string().regex(/^https:\/\//, "explorer URL must be https").nullable(),
    verifiedAt: iso.nullable(),
  }),
  payout: z.object({ mode: z.literal("SIMULATED"), status: z.enum(PAYOUT_STATUSES), reference: z.string().nullable() }),
  notification: z.object({ channel: z.literal("NTFY"), status: z.enum(NOTIFICATION_STATUSES), sentAt: iso.nullable() }),
  events: z.array(z.object({ sequence: z.number().int(), status: z.string(), createdAt: iso })),
  lastIssue: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }).nullable(),
  nextAction: z.enum(NEXT_ACTIONS),
  receipt: z.object({ id: z.string(), issuedAt: iso, summary: z.string() }).nullable(),
  createdAt: iso,
  updatedAt: iso,
});

export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    fieldErrors: z.record(z.string(), z.string()).optional(),
  }),
  meta: z.object({ requestId: z.string().optional(), apiVersion: z.string().optional() }).optional(),
});

export function envelope<T extends z.ZodType>(data: T) {
  return z.object({ data, meta: MetaSchema });
}

export type Session = z.infer<typeof SessionSchema>;
export type Recipient = z.infer<typeof RecipientSchema>;
export type Quote = z.infer<typeof QuoteSchema>;
export type TransferSnapshot = z.infer<typeof TransferSnapshotSchema>;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];
export type NextAction = (typeof NEXT_ACTIONS)[number];
export type DemoScenario = (typeof DEMO_SCENARIOS)[number];
export type CheckScenario = (typeof CHECK_SCENARIOS)[number];
