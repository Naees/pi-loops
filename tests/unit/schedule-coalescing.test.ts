import { describe, expect, it } from "vitest";
import { createProjectId } from "../../src/shared/ids.js";
import type { ScheduleRecord } from "../../src/shared/types.js";
import {
  completeScheduleOccurrence,
  reconcileMissedSchedule,
  triggerSchedule,
} from "../../src/scheduler/coalescing.js";

const projectRoot = "/tmp/pi-loops-schedule-project";
const projectId = createProjectId(projectRoot);
const createdAt = "2026-07-12T12:00:00.000Z";

function recurring(overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
  return {
    schemaVersion: 1,
    scheduleId: "schedule_1234abcd",
    projectId,
    projectRoot,
    state: "enabled",
    goal: "run checks",
    constraints: [],
    verifierCommands: [],
    budget: { maxActiveMs: 10_800_000, maxCycles: 15, stallThreshold: 3 },
    expression: "every 5m",
    normalizedExpression: "every 5 minutes",
    timing: { kind: "recurring", intervalMs: 300_000, anchorAt: createdAt },
    nextFireAt: "2026-07-12T12:05:00.000Z",
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

describe("schedule coalescing", () => {
  it("claims a due occurrence and advances recurring time", () => {
    const decision = triggerSchedule(recurring(), "run_1234abcd", new Date("2026-07-12T12:05:00.000Z"));
    expect(decision.action).toBe("start");
    expect(decision.schedule).toEqual(expect.objectContaining({
      state: "running",
      activeRunId: "run_1234abcd",
      nextFireAt: "2026-07-12T12:10:00.000Z",
    }));
  });

  it("coalesces any number of overlapping occurrences into one pending run", () => {
    let schedule = triggerSchedule(recurring(), "run_1234abcd", new Date("2026-07-12T12:05:00.000Z")).schedule;
    for (let minute = 10; minute <= 30; minute += 5) {
      schedule = triggerSchedule(schedule, `run_${minute.toString(16).padStart(8, "0")}`, new Date(`2026-07-12T12:${minute}:00.000Z`)).schedule;
    }
    expect(schedule.state).toBe("pending_coalesced");
    expect(schedule.activeRunId).toBe("run_1234abcd");
    expect(schedule.pendingSince).toBe("2026-07-12T12:10:00.000Z");
    expect(schedule.nextFireAt).toBe("2026-07-12T12:35:00.000Z");
  });

  it("starts exactly one replacement after a pending occurrence", () => {
    const running = triggerSchedule(recurring(), "run_1234abcd", new Date("2026-07-12T12:05:00.000Z")).schedule;
    const pending = triggerSchedule(running, "run_00000010", new Date("2026-07-12T12:10:00.000Z")).schedule;
    const completed = completeScheduleOccurrence(pending, "run_1234abcd", new Date("2026-07-12T12:11:00.000Z"), "run_deadbeef");

    expect(completed.action).toBe("start_pending");
    expect(completed.schedule).toEqual(expect.objectContaining({ state: "running", activeRunId: "run_deadbeef" }));
    expect(completed.schedule.pendingSince).toBeUndefined();
  });

  it("discards missed recurring occurrences and pauses missed one-offs", () => {
    const recurringSchedule = reconcileMissedSchedule(recurring(), new Date("2026-07-12T12:16:00.000Z"));
    expect(recurringSchedule.nextFireAt).toBe("2026-07-12T12:20:00.000Z");

    const oneOff = recurring({
      timing: { kind: "once", fireAt: "2026-07-12T12:05:00.000Z" },
      expression: "in 5m",
      normalizedExpression: "in 5 minutes",
    });
    const missed = reconcileMissedSchedule(oneOff, new Date("2026-07-12T12:06:00.000Z"));
    expect(missed).toEqual(expect.objectContaining({ state: "paused", pauseReason: "missed" }));
  });

  it("pauses stale running schedules after restart", () => {
    const running = triggerSchedule(recurring(), "run_1234abcd", new Date("2026-07-12T12:05:00.000Z")).schedule;
    const reconciled = reconcileMissedSchedule(running, new Date("2026-07-12T12:06:00.000Z"));
    expect(reconciled).toEqual(expect.objectContaining({ state: "paused", pauseReason: "interrupted" }));
    expect(reconciled.activeRunId).toBeUndefined();
    expect(reconciled.nextFireAt).toBeUndefined();
  });
});
