import { describe, expect, it } from "vitest";
import { createProjectId, createRunId, createScheduleId, createTriggerId, isRunId, isScheduleId, isTriggerId } from "../../src/shared/ids.js";

describe("public identifiers", () => {
  it("creates prefixed run, schedule, and trigger IDs", () => {
    const runId = createRunId();
    const scheduleId = createScheduleId();
    const triggerId = createTriggerId();

    expect(isRunId(runId)).toBe(true);
    expect(isScheduleId(scheduleId)).toBe(true);
    expect(isTriggerId(triggerId)).toBe(true);
    expect(isRunId(scheduleId)).toBe(false);
    expect(isScheduleId(triggerId)).toBe(false);
  });

  it("creates a stable project ID from the canonical root", () => {
    expect(createProjectId("/workspace/example")).toBe(createProjectId("/workspace/example"));
    expect(createProjectId("/workspace/example")).not.toBe(createProjectId("/workspace/other"));
  });
});
