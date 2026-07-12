import { describe, expect, it, vi } from "vitest";
import { allocateUniqueId } from "../../src/shared/id-allocation.js";
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

  it("allocates the first available generated ID with a finite retry bound", async () => {
    const createId = vi.fn()
      .mockReturnValueOnce("run_00000001")
      .mockReturnValueOnce("run_00000002");
    await expect(allocateUniqueId(createId, async (id) => id.endsWith("2"), "allocation failed"))
      .resolves.toBe("run_00000002");
    await expect(allocateUniqueId(() => "occupied", async () => false, "allocation failed"))
      .rejects.toThrow("allocation failed");
  });

  it("creates a stable project ID from the canonical root", () => {
    expect(createProjectId("/workspace/example")).toBe(createProjectId("/workspace/example"));
    expect(createProjectId("/workspace/example")).not.toBe(createProjectId("/workspace/other"));
  });
});
