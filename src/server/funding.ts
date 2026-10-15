import "server-only";
import { z } from "zod";
import { getTransferForUpdate, insertFundingAttempt, withTransaction } from "@/db";
import { planTransition, type Issue } from "@/domain";
import { ApiError } from "@/lib/errors";
import { ID_PREFIX, newId } from "@/lib/ids";
import { simulateFunding } from "@/simulators/funding";
import { completeKey, fingerprint, reserveKey } from "./idempotency";
import { rowToRecord } from "./mapping";
import { loadSnapshot, persistTransition, snapshotOfRow } from "./snapshots";
import type { MutationResult, ServiceDeps } from "./transfers";

/** `POST /api/demo/transfers/{id}/funding` body: exactly `{}`. */
export const fundingBody = z.strictObject({});

export const FUNDING_DECLINED_ISSUE: Issue = {
  code: "FUNDING_DECLINED",
  message: "Simulated funding was declined.",
  retryable: false,
};

/**
 * Simulate funding in one READ COMMITTED transaction (api-contract section 7):
 * lock the owner's transfer -> reserve key (scope FUNDING, transferId) ->
 * (replay | require FUNDING_PENDING -> insert funding attempt -> transition +
 * event -> complete key).
 *
 * The transfer is locked before the key is reserved: the key row references the
 * transfer (FK), ownership must be checked before any replay, and a single lock
 * order (transfer, then key) avoids deadlocks between concurrent requests.
 */
export async function simulateTransferFunding(
  input: { ownerId: string; transferId: string; idempotencyKey: string; requestId: string },
  deps: ServiceDeps = {},
): Promise<MutationResult> {
  const { ownerId, transferId, idempotencyKey: key } = input;
  const fp = fingerprint("FUNDING", {}, transferId);

  return withTransaction(
    async (client) => {
      const locked = await getTransferForUpdate(client, transferId);
      if (!locked || locked.ownerId !== ownerId) throw ApiError.notFound();

      const reserved = await reserveKey(client, { ownerId, scope: "FUNDING", key, fingerprint: fp, transferId });
      if (reserved.kind === "replay") {
        return { status: 200, replayed: true, snapshot: await loadSnapshot(client, ownerId, reserved.transferId) };
      }

      if (locked.status !== "FUNDING_PENDING") throw new ApiError("INVALID_STATE");

      const current = rowToRecord(locked);
      const sim = simulateFunding({ transferId, demoScenario: current.demoScenario });
      const attempt = await insertFundingAttempt(client, {
        id: newId(ID_PREFIX.funding),
        transferId,
        requestId: input.requestId,
        status: sim.outcome,
        reference: sim.reference,
      });

      const { rows } = await client.query<{ now: Date }>("SELECT now() AS now");
      const now = rows[0]?.now ?? new Date();
      const planned =
        sim.outcome === "ACCEPTED"
          ? planTransition(
              current,
              "FUNDED_SIMULATED",
              { funding: { status: "ACCEPTED", reference: sim.reference } },
              "FUNDING_ACCEPTED",
              now,
            )
          : planTransition(
              current,
              "FUNDING_FAILED",
              { funding: { status: "DECLINED", reference: sim.reference }, lastIssue: FUNDING_DECLINED_ISSUE },
              "FUNDING_DECLINED",
              now,
            );

      const row = await persistTransition(client, current, planned, { attemptRef: attempt.id });
      // We hold the row lock, so the version cannot have moved.
      if (!row) throw new Error("funding: transfer version moved under row lock");

      await completeKey(client, { ownerId, scope: "FUNDING", key, transferId, responseStatus: 200 });
      return { status: 200, replayed: false, snapshot: await snapshotOfRow(client, row) };
    },
    { isolationLevel: "READ COMMITTED", ...(deps.pool ? { pool: deps.pool } : {}) },
  );
}
