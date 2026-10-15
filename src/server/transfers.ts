import "server-only";
import type pg from "pg";
import { z } from "zod";
import {
  appendTransferEvent,
  CONSTRAINTS,
  getQuoteForUpdate,
  insertTransfer,
  isUniqueViolation,
  markQuoteAccepted,
  withTransaction,
} from "@/db";
import { DEMO_SCENARIOS, newTransferRecord, PURPOSES, type TransferSnapshot } from "@/domain";
import { ApiError } from "@/lib/errors";
import { ID_PREFIX, newId } from "@/lib/ids";
import { parseAmount } from "@/lib/money";
import { completeKey, fingerprint, reserveKey } from "./idempotency";
import { recordToNewTransfer } from "./mapping";
import { loadSnapshot, snapshotOfRow } from "./snapshots";

/** `POST /api/transfers` body (api-contract section 5). Extra fields are rejected. */
export const createTransferBody = z.strictObject({
  quoteId: z.string().min(1).max(128),
  purpose: z.enum(PURPOSES),
  demoScenario: z.enum(DEMO_SCENARIOS),
});
export type CreateTransferBody = z.infer<typeof createTransferBody>;

export interface MutationResult {
  status: 200 | 201 | 202;
  replayed: boolean;
  snapshot: TransferSnapshot;
}

export interface ServiceDeps {
  /** Default: the shared pool. */
  pool?: pg.Pool;
}

/**
 * Create a transfer from an accepted quote, in one READ COMMITTED transaction:
 * reserve key -> (replay | lock quote -> check -> accept -> insert transfer +
 * event -> complete key). Any thrown error rolls back the key reservation too.
 */
export async function createTransfer(
  input: { ownerId: string; idempotencyKey: string; body: CreateTransferBody },
  deps: ServiceDeps = {},
): Promise<MutationResult> {
  const { ownerId, idempotencyKey: key, body } = input;
  const fp = fingerprint("CREATE_TRANSFER", {
    quoteId: body.quoteId,
    purpose: body.purpose,
    demoScenario: body.demoScenario,
  });

  try {
    return await withTransaction(
      async (client) => {
        const reserved = await reserveKey(client, { ownerId, scope: "CREATE_TRANSFER", key, fingerprint: fp });
        if (reserved.kind === "replay") {
          // Original accepted request: return its transfer as it is now, even if the quote has expired since.
          return { status: 200, replayed: true, snapshot: await loadSnapshot(client, ownerId, reserved.transferId) };
        }

        const quote = await getQuoteForUpdate(client, ownerId, body.quoteId);
        if (!quote) throw ApiError.notFound();
        if (quote.status === "ACCEPTED") throw new ApiError("QUOTE_ALREADY_ACCEPTED");

        // Expiry by DB clock; markQuoteAccepted refuses OPEN-but-expired quotes.
        const accepted = quote.status === "OPEN" ? await markQuoteAccepted(client, quote.id) : null;
        if (!accepted) throw new ApiError("QUOTE_EXPIRED");

        if (accepted.sourceCurrency !== "USD" || accepted.destinationCurrency !== "THB") {
          throw new ApiError("UNSUPPORTED_CORRIDOR");
        }

        const { rows } = await client.query<{ now: Date }>("SELECT now() AS now");
        const now = rows[0]?.now ?? new Date();
        const r = accepted.recipientSnapshot;
        const { record, event } = newTransferRecord(
          {
            id: newId(ID_PREFIX.transfer),
            ownerId,
            quoteId: accepted.id,
            purpose: body.purpose,
            demoScenario: body.demoScenario,
            recipient: {
              id: r.id,
              name: r.name,
              bankLabel: r.bankLabel,
              accountDisplay: r.accountDisplay,
              isSynthetic: r.isSynthetic,
            },
            amounts: {
              sourceCurrency: "USD",
              destinationCurrency: "THB",
              sourceDebitMinor: parseAmount(accepted.sourceDebitMinor),
              feeMinor: parseAmount(accepted.feeMinor),
              conversionPrincipalMinor: parseAmount(accepted.conversionPrincipalMinor),
              destinationNetMinor: parseAmount(accepted.destinationNetMinor),
              settlementTokenUnits: parseAmount(accepted.settlementTokenUnits),
            },
            fx: {
              fixtureVersion: accepted.fixtureVersion,
              rateNumerator: parseAmount(accepted.fxRateNumerator),
              rateDenominator: parseAmount(accepted.fxRateDenominator),
            },
          },
          now,
        );

        const row = await insertTransfer(client, recordToNewTransfer(record));
        await appendTransferEvent(client, {
          transferId: row.id,
          fromStatus: event.fromStatus,
          toStatus: event.toStatus,
          reason: event.reason,
        });
        await completeKey(client, { ownerId, scope: "CREATE_TRANSFER", key, transferId: row.id, responseStatus: 201 });
        return { status: 201, replayed: false, snapshot: await snapshotOfRow(client, row) };
      },
      { isolationLevel: "READ COMMITTED", ...(deps.pool ? { pool: deps.pool } : {}) },
    );
  } catch (err) {
    if (isUniqueViolation(err, CONSTRAINTS.transfersQuoteId)) throw new ApiError("QUOTE_ALREADY_ACCEPTED");
    throw err;
  }
}
