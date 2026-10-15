import "server-only";
import { z } from "zod";
import { getTransferForUpdate, insertPayoutAttempt, withTransaction } from "@/db";
import { planTransition } from "@/domain";
import { ApiError } from "@/lib/errors";
import { ID_PREFIX, newId } from "@/lib/ids";
import { payoutReference } from "@/simulators/payout";
import { PAYOUT_REQUEST_PREFIX } from "./advance";
import { completeKey, fingerprint, reserveKey } from "./idempotency";
import { rowToRecord } from "./mapping";
import { loadSnapshot, persistTransition, snapshotOfRow } from "./snapshots";
import type { MutationResult, ServiceDeps } from "./transfers";

/** `POST /api/demo/transfers/{id}/payout-retry` body: exactly `{}`. */
export const payoutRetryBody = z.strictObject({});

/**
 * Deliberate payout retry in one READ COMMITTED transaction (api-contract
 * section 7): lock the owner's transfer -> reserve key (scope PAYOUT_RETRY,
 * transferId) -> (replay | require PAYOUT_FAILED -> insert payout attempt
 * attempt_no + 1 with a new request ID -> PAYOUT_FAILED -> PAYOUT_PENDING +
 * event -> complete key). Never touches settlement. The next `/advance` runs
 * the payout simulator for the new attempt.
 *
 * Same lock order as funding (transfer, then key). The key reservation and the
 * new attempt commit together, so a repeated original request replays and can
 * never create another attempt, even after the transfer has moved on.
 */
export async function retryTransferPayout(
  input: { ownerId: string; transferId: string; idempotencyKey: string },
  deps: ServiceDeps = {},
): Promise<MutationResult> {
  const { ownerId, transferId, idempotencyKey: key } = input;
  const fp = fingerprint("PAYOUT_RETRY", {}, transferId);

  return withTransaction(
    async (client) => {
      const locked = await getTransferForUpdate(client, transferId);
      if (!locked || locked.ownerId !== ownerId) throw ApiError.notFound();

      const reserved = await reserveKey(client, { ownerId, scope: "PAYOUT_RETRY", key, fingerprint: fp, transferId });
      if (reserved.kind === "replay") {
        return { status: 200, replayed: true, snapshot: await loadSnapshot(client, ownerId, reserved.transferId) };
      }

      if (locked.status !== "PAYOUT_FAILED") throw new ApiError("INVALID_STATE");

      const current = rowToRecord(locked);
      const attempt = await insertPayoutAttempt(client, {
        id: newId(ID_PREFIX.payout),
        transferId,
        requestId: newId(PAYOUT_REQUEST_PREFIX),
      });

      const { rows } = await client.query<{ now: Date }>("SELECT now() AS now");
      const now = rows[0]?.now ?? new Date();
      const planned = planTransition(
        current,
        "PAYOUT_PENDING",
        { payout: { status: "PENDING", reference: payoutReference(attempt.id) }, lastIssue: null },
        "PAYOUT_RETRY",
        now,
      );

      const row = await persistTransition(client, current, planned, { attemptRef: attempt.id });
      // We hold the row lock, so the version cannot have moved.
      if (!row) throw new Error("payout-retry: transfer version moved under row lock");

      await completeKey(client, { ownerId, scope: "PAYOUT_RETRY", key, transferId, responseStatus: 202 });
      return { status: 202, replayed: false, snapshot: await snapshotOfRow(client, row) };
    },
    { isolationLevel: "READ COMMITTED", ...(deps.pool ? { pool: deps.pool } : {}) },
  );
}
