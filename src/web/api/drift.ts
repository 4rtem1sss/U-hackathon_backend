/** Snapshots that failed schema validation in real mode. The UI shows them as a hold, never as data. */
const drifted = new WeakSet<object>();

export function markDrifted<T extends object>(value: T): T {
  drifted.add(value);
  return value;
}

export function isDrifted(value: unknown): boolean {
  return typeof value === "object" && value !== null && drifted.has(value);
}
