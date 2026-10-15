import type { DemoScenario } from "@/domain";

/**
 * Local fiat funding simulator. Deterministic by the transfer's saved scenario:
 * FUNDING_DECLINED declines; every other scenario accepts. No real money moves.
 */

export type FundingOutcome = "ACCEPTED" | "DECLINED";

export interface FundingSimResult {
  outcome: FundingOutcome;
  /** Local simulator reference, stable per transfer. */
  reference: string;
}

export function simulateFunding(input: { transferId: string; demoScenario: DemoScenario }): FundingSimResult {
  return {
    outcome: input.demoScenario === "FUNDING_DECLINED" ? "DECLINED" : "ACCEPTED",
    reference: `funding_sim_${input.transferId}`,
  };
}
