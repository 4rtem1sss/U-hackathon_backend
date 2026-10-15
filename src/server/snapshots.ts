import "server-only";
import type pg from "pg";
import { getEnv } from "@/config/env";
import {
  appendTransferEvent,
  getTransferById,
  getTransferForOwner,
  listTransferEvents,
  updateTransferWithVersion,
  type Queryable,
  type TransferRow,
} from "@/db";
import { toSnapshot, type PlannedTransition, type SnapshotConfig, type TransferRecord, type TransferSnapshot } from "@/domain";
import { ApiError } from "@/lib/errors";
import { eventRowToEvent, recordToPatch, rowToRecord } from "./mapping";

/** Test USDC on Fuji has 6 decimals (api-contract section 6). */
export const USDC_TOKEN_DECIMALS = 6;

/** Snapshot config from server env (never from the client). */
export function snapshotConfig(): SnapshotConfig {
  return { tokenAddress: getEnv().USDC_TOKEN_ADDRESS, tokenDecimals: USDC_TOKEN_DECIMALS };
}

/** Build the public snapshot of an already-loaded row (reads its events). */
export async function snapshotOfRow(db: Queryable, row: TransferRow): Promise<TransferSnapshot> {
  const events = await listTransferEvents(db, row.id);
  return toSnapshot(rowToRecord(row), events.map(eventRowToEvent), snapshotConfig());
}

/**
 * Owner-scoped snapshot read. 404 NOT_FOUND for a missing transfer or another
 * owner's transfer. Pure read: no locks, no writes.
 */
export async function loadSnapshot(db: Queryable, ownerId: string, transferId: string): Promise<TransferSnapshot> {
  const row = await getTransferForOwner(db, ownerId, transferId);
  if (!row) throw ApiError.notFound();
  return snapshotOfRow(db, row);
}

/** Internal (unscoped) snapshot read; callers must already have checked ownership. */
export async function loadSnapshotById(db: Queryable, transferId: string): Promise<TransferSnapshot> {
  const row = await getTransferById(db, transferId);
  if (!row) throw ApiError.notFound();
  return snapshotOfRow(db, row);
}

/**
 * Persist a planned status transition and its event atomically, inside the
 * caller's transaction (which should already hold the row lock or a fence).
 * Optimistic: `WHERE version = current.version` (and `claim_epoch` if given).
 * Returns the new row, or null if the row moved (caller re-reads / returns the
 * current snapshot, or treats it as a lost race).
 */
export async function persistTransition(
  client: pg.PoolClient,
  current: TransferRecord,
  planned: PlannedTransition,
  opts: { attemptRef?: string | null; expectedEpoch?: number } = {},
): Promise<TransferRow | null> {
  const row = await updateTransferWithVersion(
    client,
    current.id,
    current.version,
    recordToPatch(planned.next),
    opts.expectedEpoch === undefined ? {} : { expectedEpoch: opts.expectedEpoch },
  );
  if (!row) return null;
  await appendTransferEvent(client, {
    transferId: current.id,
    fromStatus: planned.event.fromStatus,
    toStatus: planned.event.toStatus,
    reason: planned.event.reason,
    attemptRef: opts.attemptRef ?? null,
  });
  return row;
}

/**
 * Persist a same-status patch (`planPatch`): bumps version, no event.
 * Returns null if the row moved.
 */
export function persistPatch(
  client: pg.PoolClient,
  current: TransferRecord,
  next: TransferRecord,
  opts: { expectedEpoch?: number } = {},
): Promise<TransferRow | null> {
  return updateTransferWithVersion(
    client,
    current.id,
    current.version,
    recordToPatch(next),
    opts.expectedEpoch === undefined ? {} : { expectedEpoch: opts.expectedEpoch },
  );
}
