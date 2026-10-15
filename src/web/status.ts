import { isDrifted } from "./api/drift";
import type { TransferSnapshot } from "./api/types";
import type { MessageKey } from "./i18n/en";

export type StepId = "funding" | "conversion" | "settlement" | "payout";
export type StepState = "todo" | "active" | "done" | "failed" | "hold";
export type EvidenceTagKind = "SIMULATED" | "TESTNET" | "MOCK";
export type TimelineStep = { id: StepId; state: StepState; tag: EvidenceTagKind; labelKey: MessageKey };
export type PrimaryAction = "FINISH_PAYMENT" | "START_OVER" | "RETRY_PAYOUT" | "SEND_ANOTHER" | null;
export type TransferView = {
  steps: TimelineStep[];
  headlineKey: MessageKey;
  action: PrimaryAction;
  showReceipt: boolean;
  issueMessage: string | null;
  notified: boolean;
};

type States = [StepState, StepState, StepState, StepState];
const ORDER: StepId[] = ["funding", "conversion", "settlement", "payout"];

function buildSteps(states: States, s: TransferSnapshot): TimelineStep[] {
  const mock = s.settlement.mode === "MOCK";
  return ORDER.map((id, i) => ({
    id,
    state: states[i] ?? "todo",
    tag: id === "settlement" ? (mock ? "MOCK" : "TESTNET") : "SIMULATED",
    labelKey: id === "settlement" ? (mock ? "step.settlementMock" : "step.settlement") : (`step.${id}` as MessageKey),
  }));
}

/** Done legs from evidence; the first unfinished leg is held. */
function holdStates(s: TransferSnapshot): States {
  const funded = s.funding.status === "ACCEPTED";
  const done = [funded, funded, s.settlement.status === "CONFIRMED", s.payout.status === "PAID"];
  let held = false;
  return done.map((d) => {
    if (d) return "done";
    if (!held) {
      held = true;
      return "hold";
    }
    return "todo";
  }) as States;
}

export function toView(s: TransferSnapshot): TransferView {
  if (isDrifted(s)) {
    // Contract drift: show a hold and read nothing else from the payload.
    return {
      steps: ORDER.map((id, i) => ({
        id,
        state: i === 0 ? "hold" : "todo",
        tag: id === "settlement" ? "TESTNET" : "SIMULATED",
        labelKey: id === "settlement" ? "step.settlement" : (`step.${id}` as MessageKey),
      })),
      headlineKey: "track.headline.hold",
      action: null,
      showReceipt: false,
      issueMessage: null,
      notified: false,
    };
  }
  const base = {
    issueMessage: s.lastIssue?.message ?? null,
    notified: s.notification.status === "SENT",
    showReceipt: false,
    action: null as PrimaryAction,
  };
  const view = (states: States, headlineKey: MessageKey, extra: Partial<TransferView> = {}): TransferView => ({
    ...base,
    steps: buildSteps(states, s),
    headlineKey,
    ...extra,
  });

  switch (s.status as string) {
    case "FUNDING_PENDING":
      return view(["active", "todo", "todo", "todo"], "track.headline.paying", {
        action: s.nextAction === "SIMULATE_FUNDING" ? "FINISH_PAYMENT" : null,
      });
    case "FUNDED_SIMULATED":
    case "SETTLEMENT_PENDING":
      return view(["done", "done", "active", "todo"], "track.headline.sending");
    case "SETTLED":
    case "PAYOUT_PENDING":
      return view(["done", "done", "done", "active"], "track.headline.sending");
    case "FUNDING_FAILED":
      return view(["failed", "todo", "todo", "todo"], "track.headline.fundingFailed", { action: "START_OVER" });
    case "SETTLEMENT_FAILED":
      return view(["done", "done", "failed", "todo"], "track.headline.settlementFailed", { action: "START_OVER" });
    case "PAYOUT_FAILED":
      return view(["done", "done", "done", "failed"], "track.headline.payoutFailed", { action: "RETRY_PAYOUT" });
    case "COMPLETED_SIMULATED":
      return view(["done", "done", "done", "done"], "track.headline.done", { action: "SEND_ANOTHER", showReceipt: true });
    default:
      return view(holdStates(s), "track.headline.hold");
  }
}

const DONE_EVENT: Record<StepId, string> = {
  funding: "FUNDED_SIMULATED",
  conversion: "FUNDED_SIMULATED",
  settlement: "SETTLED",
  payout: "COMPLETED_SIMULATED",
};

export function stepTime(s: TransferSnapshot, id: StepId): string | null {
  return s.events.find((e) => e.status === DONE_EVENT[id])?.createdAt ?? null;
}
