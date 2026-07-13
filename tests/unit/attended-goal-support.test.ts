import { describe, expect, it } from "vitest";
import { retentionEligible } from "../../src/controller/attended-goal-support.js";
import type { RunRecord } from "../../src/shared/types.js";

function run(overrides: Partial<RunRecord>): RunRecord {
  return {
    state: "completed",
    ...overrides,
  } as RunRecord;
}

describe("attended goal support", () => {
  it.each([
    ["completed", {}, true],
    ["cancelled", { state: "cancelled" }, true],
    ["permanent failure", { state: "failed", failureRecoverable: false }, true],
    ["recoverable failure", { state: "failed", failureRecoverable: true }, false],
    ["interrupted", { state: "interrupted" }, false],
    ["active", { state: "running" }, false],
    ["retained worktree", { worker: { worktreeRetained: true } as RunRecord["worker"] }, false],
    ["resolved worktree", { worker: { worktreeRetained: false } as RunRecord["worker"] }, true],
  ])("classifies %s retention eligibility", (_label, overrides, expected) => {
    expect(retentionEligible(run(overrides as Partial<RunRecord>))).toBe(expected);
  });
});
