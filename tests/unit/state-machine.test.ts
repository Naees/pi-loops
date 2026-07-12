import { describe, expect, it } from "vitest";
import { InvalidRunTransitionError, canTransition, isRecoverableRun, isRecoverableState, isTerminalState, transitionRun } from "../../src/controller/state-machine.js";
import { RUN_STATES, type RunRecord, type RunState } from "../../src/shared/types.js";

const expectedTransitions: Readonly<Record<RunState, readonly RunState[]>> = {
  configuring: ["preflight", "awaiting_user", "cancelled", "interrupted", "failed"],
  preflight: ["queued", "starting", "awaiting_user", "cancelled", "interrupted", "failed"],
  queued: ["starting", "cancelled", "interrupted", "failed"],
  starting: ["running", "cancelled", "interrupted", "failed"],
  running: ["verifying", "awaiting_user", "cancelled", "interrupted", "budget_exhausted", "failed"],
  verifying: ["evaluating", "running", "awaiting_user", "cancelled", "interrupted", "budget_exhausted", "stalled", "failed"],
  evaluating: ["finalizing", "running", "awaiting_user", "cancelled", "interrupted", "budget_exhausted", "stalled", "failed"],
  finalizing: ["completed", "awaiting_user", "cancelled", "interrupted", "failed"],
  awaiting_user: ["preflight", "running", "cancelled", "failed"],
  completed: [],
  failed: ["preflight"],
  cancelled: [],
  budget_exhausted: ["preflight"],
  stalled: ["preflight"],
  interrupted: ["preflight"],
};

function run(state: RunRecord["state"] = "configuring"): RunRecord {
  return {
    schemaVersion: 1,
    runId: "run_1234abcd",
    projectId: "project_1234567890abcdef",
    mode: "goal",
    state,
    goal: "all tests pass",
    budget: { maxActiveMs: 10_800_000, maxCycles: 15, stallThreshold: 3 },
    cycle: 0,
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
    transitions: [],
  };
}

describe("run state machine", () => {
  it("matches every approved transition", () => {
    for (const from of RUN_STATES) {
      for (const to of RUN_STATES) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(expectedTransitions[from].includes(to));
      }
    }
  });

  it("records an allowed transition immutably", () => {
    const original = run();
    const next = transitionRun(original, "preflight", "contract ready", new Date("2026-07-12T01:00:00.000Z"));

    expect(original.state).toBe("configuring");
    expect(next.state).toBe("preflight");
    expect(next.updatedAt).toBe("2026-07-12T01:00:00.000Z");
    expect(next.transitions).toEqual([
      {
        from: "configuring",
        to: "preflight",
        at: "2026-07-12T01:00:00.000Z",
        reason: "contract ready",
      },
    ]);
  });

  it("rejects an invalid transition", () => {
    expect(() => transitionRun(run("completed"), "running", "invalid")).toThrow(InvalidRunTransitionError);
    expect(canTransition("completed", "running")).toBe(false);
  });

  it("classifies final and recoverable states", () => {
    expect(isTerminalState("completed")).toBe(true);
    expect(isTerminalState("cancelled")).toBe(true);
    expect(isTerminalState("stalled")).toBe(false);
    expect(isRecoverableState("interrupted")).toBe(true);
    expect(isRecoverableState("budget_exhausted")).toBe(true);
    expect(isRecoverableState("failed")).toBe(false);
    expect(isRecoverableState("completed")).toBe(false);
  });

  it("requires failure recoverability to be explicit", () => {
    expect(() => transitionRun(run("running"), "failed", "worker crashed")).toThrow("must declare");

    const recoverable = transitionRun(
      run("running"),
      "failed",
      "temporary provider failure",
      new Date("2026-07-12T01:00:00.000Z"),
      { failureRecoverable: true },
    );
    expect(isRecoverableRun(recoverable)).toBe(true);
    expect(transitionRun(recoverable, "preflight", "retry requested").state).toBe("preflight");

    const permanent = transitionRun(run("running"), "failed", "invalid schema", new Date(), {
      failureRecoverable: false,
    });
    expect(isRecoverableRun(permanent)).toBe(false);
    expect(() => transitionRun(permanent, "preflight", "retry requested")).toThrow(InvalidRunTransitionError);
  });
});
