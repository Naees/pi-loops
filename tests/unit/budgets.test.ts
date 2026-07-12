import { describe, expect, it } from "vitest";
import { EMPTY_BUDGET_LEDGER, currentActiveMs, exhaustionReason, incrementCycle, pauseActiveTime, startActiveTime } from "../../src/controller/budgets.js";

const budget = { maxActiveMs: 1_000, maxCycles: 3, stallThreshold: 2 };

describe("budget accounting", () => {
  it("counts only active time", () => {
    const active = startActiveTime(EMPTY_BUDGET_LEDGER, 100);
    expect(currentActiveMs(active, 400)).toBe(300);

    const paused = pauseActiveTime(active, 500);
    expect(currentActiveMs(paused, 5_000)).toBe(400);

    const resumed = startActiveTime(paused, 6_000);
    expect(currentActiveMs(resumed, 6_200)).toBe(600);
  });

  it("reports cycle and active-time exhaustion deterministically", () => {
    const cycles = incrementCycle(incrementCycle(incrementCycle(EMPTY_BUDGET_LEDGER)));
    expect(exhaustionReason(budget, cycles, 0)).toBe("cycles");

    const active = startActiveTime(EMPTY_BUDGET_LEDGER, 0);
    expect(exhaustionReason(budget, active, 999)).toBeUndefined();
    expect(exhaustionReason(budget, active, 1_000)).toBe("active_time");
  });

  it("rejects a backwards active-time clock", () => {
    const active = startActiveTime(EMPTY_BUDGET_LEDGER, 100);
    expect(() => pauseActiveTime(active, 99)).toThrow("clock moved backwards");
  });
});
