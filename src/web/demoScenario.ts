import { CHECK_SCENARIOS, DEMO_SCENARIOS, type CheckScenario, type DemoScenario } from "./api/types";
import { browserStorage, type KeyValueStore } from "./storage";

const KEY = "centme:scenario";
const CHECK_KEY = "centme:checkScenario";

export function readScenario(store: KeyValueStore = browserStorage("session")): DemoScenario {
  const v = store.getItem(KEY);
  return (DEMO_SCENARIOS as readonly string[]).includes(v ?? "") ? (v as DemoScenario) : "HAPPY_PATH";
}

export function writeScenario(scenario: DemoScenario, store: KeyValueStore = browserStorage("session")): void {
  store.setItem(KEY, scenario);
}

export function readCheckScenario(store: KeyValueStore = browserStorage("session")): CheckScenario {
  const v = store.getItem(CHECK_KEY);
  return (CHECK_SCENARIOS as readonly string[]).includes(v ?? "") ? (v as CheckScenario) : "PASS";
}

export function writeCheckScenario(scenario: CheckScenario, store: KeyValueStore = browserStorage("session")): void {
  store.setItem(CHECK_KEY, scenario);
}
