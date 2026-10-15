import "server-only";
import type pg from "pg";
import { z } from "zod";
import { getEnv } from "@/config/env";
import {
  claimTransfer,
  getLatestPayoutAttempt,
  getPool,
  getTransferForOwner,
  getTransferForUpdate,
  insertPayoutAttempt,
  releaseTransfer,
  withTransaction,
  type PayoutAttemptRow,
  type TransferRow,
} from "@/db";
import {
  buildReceipt,
  mapSettlementError,
  mapSettlementResult,
  nextActionFor,
  planPatch,
  planTransition,
  type Issue,
  type SettlementMapping,
  type TransferRecord,
  type TransferStatus,
} from "@/domain";
import { ApiError } from "@/lib/errors";
import { ID_PREFIX, newId } from "@/lib/ids";
import {
  buildSettlementIntent,
  getSettlementModule,
  isStaleFenceError,
  registerFenceGuard,
  type Fence,
  type SettlementIntentConfig,
  type SettlementModule,
  type SettlementResult,
} from "@/settlement";
import { dbFenceGuard } from "@/settlement/db-fence-guard";
import { getNotifier, type Notifier } from "@/notifications/ntfy";
import { getPayoutSimulator, payoutReference, type PayoutSimulator } from "@/simulators/payout";
import { rowToRecord } from "./mapping";
import { loadSnapshotById, persistPatch, persistTransition, snapshotOfRow } from "./snapshots";
import type { MutationResult, ServiceDeps } from "./transfers";

/** `POST /api/demo/transfers/{id}/advance` body: exactly `{}`. */
export const advanceBody = z.strictObject({});

/** Claim lease for one `/advance` call (plan section 4.4). */
export const ADVANCE_CLAIM_TTL_SECONDS = 20;

/** Request-ID prefix for payout attempts (stable per attempt; reused to query UNKNOWN outcomes). */
export const PAYOUT_REQUEST_PREFIX = "preq";

export const PAYOUT_FAILED_ISSUE: Issue = {
  code: "PAYOUT_FAILED",
  message: "The simulated payout failed. You can retry the payout.",
  retryable: true,
};

/** Statuses `/advance` has work for. Everything else is a 200 no-op. */
const ACTIONABLE: ReadonlySet<TransferStatus> = new Set([
  "FUNDED_SIMULATED",
  "SETTLEMENT_PENDING",
  "SETTLED",
  "PAYOUT_PENDING",
]);

export interface AdvanceDeps extends ServiceDeps {
  /** Default: the process-wide module from `getSettlementModule()` with the DB fence guard. */
  settlement?: SettlementModule;
  /** Default: the process-wide payout simulator. */
  payoutSimulator?: PayoutSimulator;
  /** Default: the process-wide ntfy notifier from env. */
  notifier?: Notifier;
  /** Default: `getEnv()`. */
  settlementConfig?: SettlementIntentConfig;
  /** Default: 20 s. */
  claimTtlSeconds?: number;
  /** Server-side log for swallowed dependency errors. Default: console. */
  logger?: Pick<Console, "warn">;
}

function defaultSettlementModule(): SettlementModule {
  registerFenceGuard(dbFenceGuard);
  return getSettlementModule({ fenceGuard: dbFenceGuard });
}

/** The caller lost its claim (fence moved) or the row changed under it: stop without writing. */
class StopStep extends Error {
  constructor() {
    super("advance: stop");
    this.name = "StopStep";
  }
}

async function dbNow(client: pg.PoolClient): Promise<Date> {
  const { rows } = await client.query<{ now: Date }>("SELECT now() AS now");
  return rows[0]?.now ?? new Date();
}

interface StepContext {
  pool: pg.Pool | undefined;
  fence: Fence;
  deps: AdvanceDeps;
}

/**
 * Short fenced transaction: lock the row, require `claim_epoch === fence.epoch`
 * and the expected status, then run `fn`. Returns null when the fence is stale
 * or the status moved (someone else progressed it): the caller just stops.
 */
async function fencedTx<T>(
  ctx: StepContext,
  expected: TransferStatus,
  fn: (client: pg.PoolClient, current: TransferRecord, now: Date) => Promise<T>,
): Promise<T | null> {
  try {
    return await withTransaction(
      async (client) => {
        const locked = await getTransferForUpdate(client, ctx.fence.transferId);
        if (!locked || locked.claimEpoch !== ctx.fence.epoch || locked.status !== expected) throw new StopStep();
        return fn(client, rowToRecord(locked), await dbNow(client));
      },
      { isolationLevel: "READ COMMITTED", ...(ctx.pool ? { pool: ctx.pool } : {}) },
    );
  } catch (err) {
    if (err instanceof StopStep) return null;
    throw err;
  }
}

/** Persist a planned row change under the fence; a null row (moved) aborts the tx. */
function requireRow(row: TransferRow | null): TransferRow {
  if (!row) throw new StopStep();
  return row;
}

function newPayoutAttempt(client: pg.PoolClient, transferId: string): Promise<PayoutAttemptRow> {
  return insertPayoutAttempt(client, {
    id: newId(ID_PREFIX.payout),
    transferId,
    requestId: newId(PAYOUT_REQUEST_PREFIX),
  });
}

/** FUNDED_SIMULATED -> SETTLEMENT_PENDING (settlement PREPARING). */
function startSettlement(ctx: StepContext): Promise<TransferRow | null> {
  return fencedTx(ctx, "FUNDED_SIMULATED", async (client, current, now) => {
    const planned = planTransition(
      current,
      "SETTLEMENT_PENDING",
      { settlement: { status: "PREPARING" } },
      "SETTLEMENT_STARTED",
      now,
    );
    return requireRow(await persistTransition(client, current, planned, { expectedEpoch: ctx.fence.epoch }));
  });
}

/** Apply a settlement mapping in one fenced transaction. */
function applySettlement(
  ctx: StepContext,
  map: (current: TransferRecord, now: Date) => SettlementMapping,
  attemptRef: string | null,
): Promise<TransferRow | null> {
  return fencedTx(ctx, "SETTLEMENT_PENDING", async (client, current, now) => {
    const mapping = map(current, now);
    const opts = { expectedEpoch: ctx.fence.epoch };
    switch (mapping.kind) {
      case "NO_CHANGE":
        return null;
      case "PATCH":
        return requireRow(await persistPatch(client, current, mapping.next, opts));
      case "TRANSITION": {
        const row = requireRow(await persistTransition(client, current, mapping, { ...opts, attemptRef }));
        if (mapping.createPayoutAttempt) await newPayoutAttempt(client, current.id);
        return row;
      }
    }
  });
}

/**
 * SETTLEMENT_PENDING: one bounded `settlement.step()` OUTSIDE any DB
 * transaction, then map the result in a short fenced transaction.
 */
async function stepSettlement(ctx: StepContext, record: TransferRecord): Promise<void> {
  const settlement = ctx.deps.settlement ?? defaultSettlementModule();
  let result: SettlementResult;
  try {
    const intent = buildSettlementIntent(
      { id: record.id, settlementTokenUnits: record.amounts.settlementTokenUnits },
      ctx.deps.settlementConfig ?? getEnv(),
    );
    result = await settlement.step(intent, ctx.fence);
  } catch (err) {
    // Lost the claim: someone else is working on it; write nothing.
    if (isStaleFenceError(err)) return;
    // Dependency unavailable, nothing decided: status/substatus unchanged.
    (ctx.deps.logger ?? console).warn(
      `[advance] settlement step failed for ${record.id}: ${err instanceof Error ? err.name : "error"}`,
    );
    await applySettlement(ctx, (current, now) => mapSettlementError(current, now), null);
    return;
  }
  await applySettlement(
    ctx,
    (current, now) => mapSettlementResult(current, result, now),
    result.attemptId,
  );
}

/** SETTLED -> PAYOUT_PENDING with the payout attempt (created now if missing). */
function startPayout(ctx: StepContext): Promise<TransferRow | null> {
  return fencedTx(ctx, "SETTLED", async (client, current, now) => {
    const attempt = (await getLatestPayoutAttempt(client, current.id)) ?? (await newPayoutAttempt(client, current.id));
    const planned = planTransition(
      current,
      "PAYOUT_PENDING",
      { payout: { status: "PENDING", reference: payoutReference(attempt.id) } },
      "PAYOUT_STARTED",
      now,
    );
    return requireRow(
      await persistTransition(client, current, planned, { expectedEpoch: ctx.fence.epoch, attemptRef: attempt.id }),
    );
  });
}

/**
 * PAYOUT_PENDING: run the payout simulator for the latest attempt's stable
 * request ID. The simulator is local, so it runs inside the fenced transaction
 * and its stored outcome commits together with the transfer change.
 */
function stepPayout(ctx: StepContext): Promise<TransferRow | null> {
  return fencedTx(ctx, "PAYOUT_PENDING", async (client, current, now) => {
    const attempt = await getLatestPayoutAttempt(client, current.id);
    if (!attempt) throw new Error(`advance: PAYOUT_PENDING transfer ${current.id} has no payout attempt`);
    const sim = await (ctx.deps.payoutSimulator ?? getPayoutSimulator()).execute(client, {
      requestId: attempt.requestId,
      demoScenario: current.demoScenario,
    });
    const opts = { expectedEpoch: ctx.fence.epoch, attemptRef: sim.attemptId };

    if (sim.outcome === "UNKNOWN") {
      if (current.payout.status === "UNKNOWN") return null;
      const next = planPatch(current, { payout: { status: "UNKNOWN", reference: sim.reference } }, now);
      return requireRow(await persistPatch(client, current, next, opts));
    }
    const planned =
      sim.outcome === "PAID"
        ? planTransition(
            current,
            "COMPLETED_SIMULATED",
            {
              payout: { status: "PAID", reference: sim.reference },
              receipt: buildReceipt(now),
              lastIssue: null,
              notification: { status: notifierFor(ctx).enabled ? "PENDING" : "DISABLED" },
            },
            "PAYOUT_PAID",
            now,
          )
        : planTransition(
            current,
            "PAYOUT_FAILED",
            { payout: { status: "FAILED", reference: sim.reference }, lastIssue: PAYOUT_FAILED_ISSUE },
            "PAYOUT_FAILED",
            now,
          );
    return requireRow(await persistTransition(client, current, planned, opts));
  });
}

function notifierFor(ctx: StepContext): Notifier {
  return ctx.deps.notifier ?? getNotifier();
}

/** Notification still owed: PENDING (just completed, or a crash mid-send) or FAILED (retry on a later call). */
function notificationOwed(row: Pick<TransferRow, "status" | "notificationStatus">): boolean {
  return row.status === "COMPLETED_SIMULATED" && (row.notificationStatus === "PENDING" || row.notificationStatus === "FAILED");
}

/**
 * COMPLETED_SIMULATED with a notification owed: one bounded ntfy POST outside
 * any DB transaction, then record SENT/FAILED under the fence. Best effort and
 * at-least-once: a crash after the push but before the write re-sends later.
 * Never changes the transfer status or nextAction.
 */
async function deliverNotification(ctx: StepContext, record: TransferRecord): Promise<void> {
  const notifier = notifierFor(ctx);
  if (!notifier.enabled) return;
  const outcome = await notifier.notifyCompleted(record);
  await fencedTx(ctx, "COMPLETED_SIMULATED", async (client, current, now) => {
    const status = current.notification.status;
    if (status !== "PENDING" && status !== "FAILED") return null;
    if (outcome === "FAILED" && status === "FAILED") return null;
    const next = planPatch(
      current,
      { notification: outcome === "SENT" ? { status: "SENT", sentAt: now } : { status: "FAILED", sentAt: null } },
      now,
    );
    return requireRow(await persistPatch(client, current, next, { expectedEpoch: ctx.fence.epoch }));
  });
}

/** One bounded step for the claimed transfer (plan section 5). */
async function runStep(ctx: StepContext, row: TransferRow): Promise<void> {
  switch (row.status) {
    case "FUNDED_SIMULATED": {
      const started = await startSettlement(ctx);
      if (started) await stepSettlement(ctx, rowToRecord(started));
      return;
    }
    case "SETTLEMENT_PENDING":
      await stepSettlement(ctx, rowToRecord(row));
      return;
    case "SETTLED":
      await startPayout(ctx);
      return;
    case "PAYOUT_PENDING": {
      const done = await stepPayout(ctx);
      if (done && notificationOwed(done)) await deliverNotification(ctx, rowToRecord(done));
      return;
    }
    case "COMPLETED_SIMULATED":
      if (notificationOwed(row)) await deliverNotification(ctx, rowToRecord(row));
      return;
    default:
      return;
  }
}

function statusFor(nextAction: string): 200 | 202 {
  return nextAction === "ADVANCE" ? 202 : 200;
}

/**
 * `POST /api/demo/transfers/{id}/advance` (api-contract section 7, plan section 5).
 *
 * Owner check (404) -> no-op 200 for statuses with no `/advance` work ->
 * claim (none: someone else is working, 202 with the current snapshot) ->
 * one bounded step -> release claim -> snapshot (202 while nextAction is
 * still ADVANCE, else 200). No idempotency key: every repeat is made safe by
 * the claim/fence, the version check and persisted attempts.
 */
export async function advanceTransfer(
  input: { ownerId: string; transferId: string },
  deps: AdvanceDeps = {},
): Promise<MutationResult> {
  const { ownerId, transferId } = input;
  const db = deps.pool ?? getPool();

  const row = await getTransferForOwner(db, ownerId, transferId);
  if (!row) throw ApiError.notFound();
  if (!ACTIONABLE.has(row.status) && !notificationOwed(row)) {
    return { status: 200, replayed: false, snapshot: await snapshotOfRow(db, row) };
  }

  const epoch = await claimTransfer(transferId, deps.claimTtlSeconds ?? ADVANCE_CLAIM_TTL_SECONDS, db);
  if (epoch === null) {
    return { status: 202, replayed: false, snapshot: await loadSnapshotById(db, transferId) };
  }

  try {
    // Re-read after claiming: the row may have moved between the first read and the claim.
    const claimed = await getTransferForOwner(db, ownerId, transferId);
    if (claimed) await runStep({ pool: deps.pool, fence: { transferId, epoch }, deps }, claimed);
  } finally {
    await releaseTransfer(transferId, epoch, db);
  }

  const snapshot = await loadSnapshotById(db, transferId);
  return { status: statusFor(nextActionFor(snapshot.status)), replayed: false, snapshot };
}
