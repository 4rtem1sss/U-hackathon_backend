import "server-only";
import { z } from "zod";

/**
 * Server-side configuration, validated with zod.
 *
 * Parsing is lazy (first call to `getEnv()`), so `next build` works without any
 * environment variables. Never read secrets through `NEXT_PUBLIC_*` names; this
 * module is server-only and must not be imported from client components.
 */

const hexAddress = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 20-byte hex address");

const optionalNonEmpty = z
  .string()
  .trim()
  .transform((v) => (v === "" ? undefined : v))
  .optional();

const positiveIntFromString = (def: number) =>
  z.coerce.number().int().positive().default(def);

export const envSchema = z.object({
  APP_MODE: z.enum(["development", "test", "demo", "production"]).default("development"),
  DATABASE_URL: z
    .string()
    .min(1, "is required")
    .refine((v) => /^postgres(ql)?:\/\//.test(v), "must be a postgres:// or postgresql:// URL"),
  AVALANCHE_CHAIN_ID: z.coerce.number().int().positive().default(43113),
  AVALANCHE_RPC_URL: z.url().default("https://api.avax-test.network/ext/bc/C/rpc"),
  USDC_TOKEN_ADDRESS: hexAddress.default("0x5425890298aed601595a70AB815c96711a31Bc65"),
  DESTINATION_SETTLEMENT_ADDRESS: hexAddress,
  /** Owned by part 4 (settlement signer). Optional for part 3. */
  SETTLEMENT_PRIVATE_KEY: optionalNonEmpty.pipe(
    z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte hex key")
      .optional(),
  ),
  /** Only needed if part 4 runs as a separate service (HTTP RPC form). */
  INTERNAL_RPC_SECRET: optionalNonEmpty.pipe(z.string().min(32, "must be at least 32 characters").optional()),
  /** Which SettlementModule to use: in-memory fake (tests/dev) or part 4's real Fuji module. */
  SETTLEMENT_MODULE: optionalNonEmpty.pipe(z.enum(["fake", "fuji"]).optional()),
  /** ntfy server for recipient push notifications. */
  NTFY_BASE_URL: z.url().default("https://ntfy.sh"),
  /** ntfy topic the recipient subscribes to. Unset = notifications DISABLED. Topic names are public on ntfy.sh, so use a hard-to-guess one. */
  NTFY_TOPIC: optionalNonEmpty.pipe(
    z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "must be 1-64 letters, digits, _ or -").optional(),
  ),
  /** Optional ntfy access token (Bearer) for protected topics. */
  NTFY_TOKEN: optionalNonEmpty,
  NTFY_TIMEOUT_MS: positiveIntFromString(3000),
  QUOTE_TTL_SECONDS: positiveIntFromString(300),
  SETTLEMENT_CONFIRMATIONS: positiveIntFromString(2),
  ALLOWED_ORIGINS: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim().replace(/\/+$/, ""))
        .filter((s) => s.length > 0),
    )
    .pipe(z.array(z.url())),
});

export type Env = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  constructor(public readonly issues: string[]) {
    // Only variable names and rule messages: never echo values (they may be secrets).
    super(`Invalid server configuration:\n  - ${issues.join("\n  - ")}`);
    this.name = "EnvValidationError";
  }
}

/** Parse an env-like record. Exported for tests; app code should use `getEnv()`. */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    );
  }
  return result.data;
}

let cached: Env | undefined;

/** Lazily parse and cache `process.env`. Throws `EnvValidationError` if invalid. */
export function getEnv(): Env {
  if (!cached) cached = parseEnv(process.env);
  return cached;
}

/** Test helper: drop the cached config so the next `getEnv()` re-reads `process.env`. */
export function resetEnvCache(): void {
  cached = undefined;
}
