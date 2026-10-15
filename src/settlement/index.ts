/**
 * Settlement module factory: picks the fake or part 4's real Fuji module by
 * `SETTLEMENT_MODULE` (fake | fuji).
 *
 * - Unset: `fake` when APP_MODE is development/test (or unset); an error in
 *   demo/production, where the choice must be explicit.
 * - `fake`: {@link FakeSettlementModule} (no chain transfer happens).
 * - `fuji`: persisted Avalanche Fuji Test USDC module.
 *
 * NOTE: reads the existing server-only environment names from src/config/env.ts.
 *
 * The module is created once per process (the fake keeps its state in
 * memory). The {@link FenceGuard} comes from part 3's DB layer: pass it on the
 * first call or register it once with {@link registerFenceGuard}.
 */
import type { FenceGuard, SettlementModule } from "./contract";
import { FakeSettlementModule } from "./fake";
import { FujiSettlementModule } from "./fuji/module";
import { PgFujiAttemptStore } from "./fuji/store";
import { ViemFujiGateway } from "./fuji/gateway";
import { parseFujiConfig } from "./fuji/config";

export * from "./contract";
export { buildSettlementIntent, assertValidIntent, type SettlementIntentConfig, type SettlementIntentSource } from "./intent";
export {
  FakeSettlementModule,
  FakeDependencyError,
  InMemoryFenceGuard,
  fakeScenario,
  assertFakeSettlementAllowed,
  type FakeScenario,
  type FakeTransferStats,
} from "./fake";
export { FujiSettlementModule } from "./fuji/module";

export type SettlementModuleKind = "fake" | "fuji";

type EnvLike = Record<string, string | undefined>;

/** Resolve which module to use from env. Throws on invalid or missing-but-required values. */
export function resolveSettlementModuleKind(env: EnvLike = process.env): SettlementModuleKind {
  const raw = env.SETTLEMENT_MODULE?.trim().toLowerCase() ?? "";
  const mode = env.APP_MODE?.trim() || "development";
  if (raw === "fake" || raw === "fuji") return raw;
  if (raw !== "") {
    throw new Error(`SETTLEMENT_MODULE must be "fake" or "fuji" (got an unsupported value).`);
  }
  if (mode === "development" || mode === "test") return "fake";
  throw new Error(`SETTLEMENT_MODULE must be set explicitly when APP_MODE=${mode} ("fuji" for real settlement).`);
}

let registeredGuard: FenceGuard | undefined;
let cached: { kind: SettlementModuleKind; module: SettlementModule } | undefined;

/** Register the process-wide fence guard (part 3 DB implementation). */
export function registerFenceGuard(guard: FenceGuard): void {
  registeredGuard = guard;
}

export interface GetSettlementModuleOptions {
  fenceGuard?: FenceGuard;
  env?: EnvLike;
}

/** The process-wide settlement module (created on first call). */
export function getSettlementModule(options: GetSettlementModuleOptions = {}): SettlementModule {
  if (cached) return cached.module;
  const env = options.env ?? process.env;
  const kind = resolveSettlementModuleKind(env);
  const fenceGuard = options.fenceGuard ?? registeredGuard;
  if (!fenceGuard) {
    throw new Error("No FenceGuard wired for the settlement module (pass one or call registerFenceGuard()).");
  }
  let settlement: SettlementModule;
  if (kind === "fake") {
    settlement = new FakeSettlementModule({ fenceGuard, env });
  } else {
    const config = parseFujiConfig(env);
    settlement = new FujiSettlementModule({
      fenceGuard,
      store: new PgFujiAttemptStore(),
      gateway: new ViemFujiGateway(config),
      tokenAddress: config.tokenAddress,
      destination: config.destination,
    });
  }
  cached = { kind, module: settlement };
  return settlement;
}

/** Test helper: forget the cached module and registered guard. */
export function resetSettlementModuleForTests(): void {
  cached = undefined;
  registeredGuard = undefined;
}
