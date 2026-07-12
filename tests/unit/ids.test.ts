import { describe, expect, it } from "vitest";
import { createProjectId, createRunId, createScheduleId, isRunId, isScheduleId } from "../../src/shared/ids.js";

describe("public identifiers", () => {
  it("creates prefixed run and schedule IDs", () => {
    const runId = createRunId();
    const scheduleId = createScheduleId();

    expect(isRunId(runId)).toBe(true);
    expect(isScheduleId(scheduleId)).toBe(true);
    expect(isRunId(scheduleId)).toBe(false);
  });

  it("creates a stable project ID from the canonical root", () => {
    expect(createProjectId("/workspace/example")).toBe(createProjectId("/workspace/example"));
    expect(createProjectId("/workspace/example")).not.toBe(createProjectId("/workspace/other"));
  });
});
