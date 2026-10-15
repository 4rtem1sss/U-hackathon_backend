import { describe, expect, it } from "vitest";
import { TRANSFER_STATUSES } from "@/domain/enums";
import { toSnapshot } from "@/domain/snapshot";
import { SNAPSHOT_CONFIG, recordAt } from "../../domain/fixtures";
import { TransferSnapshotSchema } from "@/web/api/types";

// Drift guard: the frontend schema must accept what the backend's toSnapshot really builds.
// Test-only import of backend code; frontend source never imports it.
describe("frontend schema vs backend toSnapshot", () => {
  it.each(TRANSFER_STATUSES)("accepts the backend snapshot at %s", (status) => {
    const { record, events } = recordAt(status);
    const parsed = TransferSnapshotSchema.safeParse(toSnapshot(record, events, SNAPSHOT_CONFIG));
    expect(parsed.error?.issues ?? []).toEqual([]);
  });
});
