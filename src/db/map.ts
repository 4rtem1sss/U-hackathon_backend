/** snake_case column name -> camelCase property name. */
function camel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** Map a pg row (snake_case columns) to a camelCase record. Values are untouched. */
export function mapRow<T>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[camel(k)] = v;
  return out as T;
}

/** Serialize a value for a jsonb parameter (pg would turn JS arrays into PG arrays). */
export function jsonParam(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}
