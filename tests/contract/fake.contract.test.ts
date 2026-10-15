import { randomUUID } from "node:crypto";
import { FakeSettlementModule, InMemoryFenceGuard, fakeScenario } from "@/settlement/fake";
import { buildSettlementIntent } from "@/settlement/intent";
import { runSettlementContractSuite } from "./settlement.contract";

const config = {
  AVALANCHE_CHAIN_ID: 43113,
  USDC_TOKEN_ADDRESS: "0x5425890298aed601595a70AB815c96711a31Bc65",
  DESTINATION_SETTLEMENT_ADDRESS: "0x000000000000000000000000000000000000dEaD",
};

function harness(name: string, scenario = fakeScenario.confirmAfter(2)) {
  runSettlementContractSuite(name, () => {
    const guard = new InMemoryFenceGuard();
    const mod = new FakeSettlementModule({ fenceGuard: guard, defaultScenario: scenario, env: {} });
    return {
      module: mod,
      async newTransfer() {
        const id = `tr_${randomUUID()}`;
        const intent = buildSettlementIntent({ id, settlementTokenUnits: 9_800_000n }, config);
        return { intent, fence: guard.claim(id) };
      },
      async makeStale(fence) {
        return guard.claim(fence.transferId);
      },
      async countAttempts(transferId) {
        const s = mod.stats(transferId);
        return { attempts: s.attemptsCreated, hashes: s.distinctHashes };
      },
      failNextStep: (id) => mod.failNextStep(id),
      loseNextBroadcastResponse: (id) => mod.loseNextBroadcastResponse(id),
      scriptRevert: (id) => mod.script(id, fakeScenario.revert(2)),
    };
  });
}

harness("FakeSettlementModule (confirmAfter 2)");
harness("FakeSettlementModule (confirm on broadcast step)", fakeScenario.confirmAfter(1));
harness("FakeSettlementModule (separate prepare step)", fakeScenario.prepareFirst(fakeScenario.confirmAfter(4)));
