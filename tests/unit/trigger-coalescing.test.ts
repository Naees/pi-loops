import { describe, expect, it } from "vitest";
import type { TriggerRecord } from "../../src/shared/types.js";
import { completeTriggerOccurrence, enableTrigger, fireTrigger, interruptTriggerOccurrence, pauseTrigger, resumeTriggerOccurrence } from "../../src/triggers/coalescing.js";

function trigger(overrides: Partial<TriggerRecord> = {}): TriggerRecord {
  return {
    schemaVersion: 1,
    triggerId: "trigger_1234abcd",
    projectId: "project_1234567890abcdef",
    projectRoot: "/tmp/project",
    state: "enabled",
    goal: "fix generated code",
    constraints: [],
    verifierCommands: [],
    budget: { maxActiveMs: 60_000, maxCycles: 3, stallThreshold: 2 },
    source: { kind: "event" },
    createdAt: "2026-07-12T12:00:00.000Z",
    updatedAt: "2026-07-12T12:00:00.000Z",
    ...overrides,
  };
}

describe("trigger coalescing", () => {
  it("starts one occurrence and coalesces any trigger storm into one pending run", () => {
    let current = fireTrigger(trigger(), "run_1234abcd", new Date("2026-07-12T12:01:00.000Z")).trigger;
    for (let index = 0; index < 100; index += 1) {
      current = fireTrigger(current, "run_deadbeef", new Date(Date.parse("2026-07-12T12:02:00.000Z") + index)).trigger;
    }
    expect(current).toEqual(expect.objectContaining({
      state: "pending_coalesced",
      activeRunId: "run_1234abcd",
      pendingSince: "2026-07-12T12:02:00.000Z",
    }));
  });

  it("transfers exactly one pending occurrence and then re-enables the definition", () => {
    const running = fireTrigger(trigger(), "run_1234abcd", new Date("2026-07-12T12:01:00.000Z")).trigger;
    const pending = fireTrigger(running, "run_deadbeef", new Date("2026-07-12T12:02:00.000Z")).trigger;
    const replacement = completeTriggerOccurrence(pending, "run_1234abcd", new Date("2026-07-12T12:03:00.000Z"), "run_deadbeef");
    expect(replacement).toEqual(expect.objectContaining({ action: "start_pending" }));
    expect(replacement.trigger).toEqual(expect.objectContaining({ state: "running", activeRunId: "run_deadbeef" }));
    const completed = completeTriggerOccurrence(replacement.trigger, "run_deadbeef", new Date("2026-07-12T12:04:00.000Z"));
    expect(completed.trigger).toEqual(expect.objectContaining({ state: "enabled", lastCompletedAt: "2026-07-12T12:04:00.000Z" }));
  });

  it("re-enables interrupted definitions and supports explicit run resume", () => {
    const running = fireTrigger(trigger(), "run_1234abcd", new Date("2026-07-12T12:01:00.000Z")).trigger;
    const interrupted = interruptTriggerOccurrence(running, "run_1234abcd", new Date("2026-07-12T12:02:00.000Z"));
    expect(interrupted).toEqual(expect.objectContaining({ state: "enabled" }));
    expect(interrupted.activeRunId).toBeUndefined();
    expect(resumeTriggerOccurrence(interrupted, "run_1234abcd", new Date("2026-07-12T12:03:00.000Z")))
      .toEqual(expect.objectContaining({ state: "running", activeRunId: "run_1234abcd" }));
  });

  it("pauses and re-enables inactive definitions", () => {
    const paused = pauseTrigger(trigger(), new Date("2026-07-12T12:01:00.000Z"));
    expect(paused.state).toBe("paused");
    expect(enableTrigger(paused, new Date("2026-07-12T12:02:00.000Z"))).toEqual(expect.objectContaining({ state: "enabled" }));
    const running = fireTrigger(trigger(), "run_1234abcd", new Date()).trigger;
    expect(() => pauseTrigger(running, new Date())).toThrow("must be stopped");
    expect(() => enableTrigger(trigger(), new Date())).toThrow("not paused");
  });

  it("ignores paused definitions and rejects invalid identities and transitions", () => {
    expect(fireTrigger(trigger({ state: "paused" }), "run_1234abcd", new Date()).action).toBe("ignored");
    expect(() => fireTrigger(trigger(), "invalid", new Date())).toThrow("Invalid run ID");
    expect(() => completeTriggerOccurrence(trigger(), "run_1234abcd", new Date())).toThrow("not running occurrence");
    const pending = fireTrigger(
      fireTrigger(trigger(), "run_1234abcd", new Date("2026-07-12T12:01:00.000Z")).trigger,
      "run_deadbeef",
      new Date("2026-07-12T12:02:00.000Z"),
    ).trigger;
    expect(() => completeTriggerOccurrence(pending, "run_1234abcd", new Date())).toThrow("valid replacement run ID");
    expect(() => resumeTriggerOccurrence(trigger({ state: "paused" }), "run_1234abcd", new Date())).toThrow("not available");
  });
});
