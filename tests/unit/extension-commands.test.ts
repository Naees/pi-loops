import { describe, expect, it } from "vitest";
import { budgetFromTool, parseCommand, parseResumeValue, parseScheduleValue } from "../../src/extension/commands.js";

describe("extension command parsing", () => {
  it("normalizes commands and defaults an empty command to status", () => {
    expect(parseCommand("   ")).toEqual({ action: "status", value: "" });
    expect(parseCommand("GOAL   finish the task ")).toEqual({ action: "goal", value: "finish the task" });
    expect(parseCommand("watch files")).toEqual({ action: "unsupported", value: "watch" });
  });

  it("requires values for goal and schedule commands", () => {
    expect(() => parseCommand("goal")).toThrow("Usage: /loops goal <goal>");
    expect(() => parseCommand("schedule")).toThrow("Usage: /loops schedule <time-expression> -- <goal>");
  });

  it("separates a schedule expression from its goal", () => {
    expect(parseScheduleValue("every 30m -- check CI -- and fix failures")).toEqual({
      expression: "every 30m",
      goal: "check CI -- and fix failures",
    });
    for (const value of ["every 30m", " -- goal", "every 30m -- "]) {
      expect(() => parseScheduleValue(value)).toThrow("Usage: /loops schedule <time-expression> -- <goal>");
    }
  });

  it("distinguishes a run ID from free-form resume guidance", () => {
    expect(parseResumeValue("")).toEqual({});
    expect(parseResumeValue("run_1234abcd use the new API")).toEqual({ runId: "run_1234abcd", guidance: "use the new API" });
    expect(parseResumeValue("use the new API")).toEqual({ guidance: "use the new API" });
  });

  it("builds only explicitly supplied tool budget fields", () => {
    expect(budgetFromTool({})).toEqual({});
    expect(budgetFromTool({ maxCycles: 4 })).toEqual({ budget: { maxCycles: 4 } });
    expect(budgetFromTool({ maxActiveMinutes: 2 })).toEqual({ budget: { maxActiveMs: 120_000 } });
  });
});
