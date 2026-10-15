import { describe, expect, it } from "vitest";
import { readCheckScenario, readScenario, writeCheckScenario, writeScenario } from "@/web/demoScenario";
import { memoryStore } from "@/web/storage";

describe("demo scenario storage", () => {
  it("defaults to HAPPY_PATH and PASS", () => {
    const store = memoryStore();
    expect(readScenario(store)).toBe("HAPPY_PATH");
    expect(readCheckScenario(store)).toBe("PASS");
  });
  it("round-trips valid values and ignores junk", () => {
    const store = memoryStore();
    writeScenario("PAYOUT_FAILED", store);
    writeCheckScenario("REVIEW", store);
    expect(readScenario(store)).toBe("PAYOUT_FAILED");
    expect(readCheckScenario(store)).toBe("REVIEW");
    store.setItem("centme:scenario", "NOPE");
    store.setItem("centme:checkScenario", "NOPE");
    expect(readScenario(store)).toBe("HAPPY_PATH");
    expect(readCheckScenario(store)).toBe("PASS");
  });
});
