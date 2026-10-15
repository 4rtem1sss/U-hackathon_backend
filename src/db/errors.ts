/** A fenced writer's claim epoch no longer matches `transfers.claim_epoch`. */
export class StaleFenceError extends Error {
  constructor(
    public readonly transferId: string,
    public readonly expectedEpoch: number,
    /** Current epoch in the DB, or null if the transfer does not exist. */
    public readonly actualEpoch: number | null,
  ) {
    super(
      actualEpoch === null
        ? `stale fence: transfer ${transferId} not found`
        : `stale fence for transfer ${transferId}: held epoch ${expectedEpoch}, current ${actualEpoch}`,
    );
    this.name = "StaleFenceError";
  }
}

export function isStaleFenceError(err: unknown): err is StaleFenceError {
  return err instanceof StaleFenceError;
}

interface PgErrorLike {
  code?: unknown;
  constraint?: unknown;
}

/** Postgres unique_violation (23505), optionally for a specific constraint/index name. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as PgErrorLike;
  return e.code === "23505" && (constraint === undefined || e.constraint === constraint);
}

/** Constraint / index names that callers map to API errors. */
export const CONSTRAINTS = {
  transfersQuoteId: "transfers_quote_id_key",
  idempotencyKeysPkey: "idempotency_keys_pkey",
  transferEventsSequence: "transfer_events_transfer_sequence_key",
  fundingAttemptsTransferId: "funding_attempts_transfer_id_key",
  payoutAttemptsRequestId: "payout_attempts_request_id_key",
  payoutAttemptsTransferAttempt: "payout_attempts_transfer_attempt_key",
  settlementSignerNonce: "settlement_attempts_signer_nonce_key",
  settlementTxHash: "settlement_attempts_tx_hash_key",
  settlementOneUnresolvedPerSigner: "settlement_attempts_one_unresolved_per_signer",
} as const;
