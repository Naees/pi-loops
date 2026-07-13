import { describe, expect, it } from "vitest";
import type { ProjectBinding } from "../../src/contracts/project-binding.js";
import {
  createUnattendedRun,
  isSafeUnattendedRestart,
  prepareUnattendedRestart,
  scheduleDefinition,
  triggerDefinition,
} from "../../src/controller/unattended-definition.js";
import { transitionRun } from "../../src/controller/state-machine.js";
import type { ScheduleRecord, TriggerRecord } from "../../src/shared/types.js";

const binding: ProjectBinding = {
  projectId: "project_1234567890abcdef",
  projectRoot: "/tmp/project",
};
const budget = { maxActiveMs: 60_000, maxCycles: 3, stallThreshold: 2 };
const at = "2026-07-12T12:00:00.000Z";

function schedule(): ScheduleRecord {
  return {
    schemaVersion: 1,
    scheduleId: "schedule_1234abcd",
    ...binding,
    state: "enabled",
    goal: "complete work",
    constraints: ["keep API"],
    verifierCommands: ["npm test"],
    budget,
    expression: "in 1m",
    normalizedExpression: "in 1 minute",
    timing: { kind: "once", fireAt: "2026-07-12T12:01:00.000Z" },
    nextFireAt: "2026-07-12T12:01:00.000Z",
    createdAt: at,
    updatedAt: at,
  };
}

function trigger(): TriggerRecord {
  return {
    schemaVersion: 1,
    triggerId: "trigger_1234abcd",
    ...binding,
    state: "enabled",
    goal: "complete work",
    constraints: ["keep API"],
    verifierCommands: ["npm test"],
    budget,
    source: { kind: "event" },
    createdAt: at,
    updatedAt: at,
  };
}

describe("unattended definitions", () => {
  it("normalizes schedules and triggers into mode-specific initial runs", () => {
    const scheduled = createUnattendedRun(binding, scheduleDefinition(schedule()), "run_1234abcd", at);
    expect(scheduled).toEqual(expect.objectContaining({ mode: "scheduled", scheduleId: "schedule_1234abcd" }));
    expect(scheduled.triggerId).toBeUndefined();

    const proactive = createUnattendedRun(binding, triggerDefinition(trigger()), "run_deadbeef", at);
    expect(proactive).toEqual(expect.objectContaining({ mode: "proactive", triggerId: "trigger_1234abcd" }));
    expect(proactive.scheduleId).toBeUndefined();
  });

  it("preserves interrupted epochs and resets exhausted epochs", () => {
    const definition = triggerDefinition(trigger());
    let interrupted = createUnattendedRun(binding, definition, "run_1234abcd", at);
    interrupted = transitionRun(interrupted, "preflight", "ready", new Date(at));
    interrupted = transitionRun(interrupted, "starting", "starting", new Date(at));
    interrupted = transitionRun(interrupted, "running", "running", new Date(at));
    interrupted = transitionRun(interrupted, "interrupted", "interrupted", new Date(at));
    interrupted = {
      ...interrupted,
      budgetDeadlineAt: "2026-07-12T12:01:00.000Z",
      worker: {
        repositoryRoot: binding.projectRoot,
        baseCommit: "a".repeat(40),
        branch: "pi-loops/run_1234abcd",
        worktreePath: "/tmp/worktree",
        sessionDirectory: "/tmp/session",
        sessionId: "session",
        sessionFile: "/tmp/session/session.jsonl",
        worktreeRetained: true,
      },
    };
    expect(isSafeUnattendedRestart(interrupted, definition)).toBe(true);
    for (const changed of [
      { ...definition, sourceId: "trigger_deadbeef" },
      { ...definition, goal: "different goal" },
      { ...definition, constraints: ["different constraint"] },
      { ...definition, verifierCommands: ["npm run lint"] },
      { ...definition, budget: { ...definition.budget, maxCycles: definition.budget.maxCycles + 1 } },
    ]) {
      expect(isSafeUnattendedRestart(interrupted, changed)).toBe(false);
    }
    const incompleteWorker: { -readonly [Key in keyof NonNullable<typeof interrupted.worker>]: NonNullable<typeof interrupted.worker>[Key] } = {
      ...interrupted.worker!,
    };
    delete incompleteWorker.sessionId;
    delete incompleteWorker.sessionFile;
    expect(isSafeUnattendedRestart({ ...interrupted, worker: incompleteWorker }, definition)).toBe(false);
    expect(prepareUnattendedRestart(interrupted, new Date("2026-07-12T12:02:00.000Z")))
      .toEqual(expect.objectContaining({ budgetEpoch: 1, budgetDeadlineAt: interrupted.budgetDeadlineAt }));

    const exhausted = { ...interrupted, state: "budget_exhausted" as const, terminalReason: "limit", cycle: 3, activeMs: 60_000 };
    const restarted = prepareUnattendedRestart(exhausted, new Date("2026-07-12T12:02:00.000Z"));
    expect(restarted).toEqual(expect.objectContaining({ budgetEpoch: 2, cycle: 0, activeMs: 0, equivalentFailures: 0 }));
    expect(restarted.budgetDeadlineAt).toBeUndefined();
    expect(restarted.budgetHistory).toHaveLength(1);
  });
});
