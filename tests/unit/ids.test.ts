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
    const occupied = vi.fn(() => "occupied");
    const unavailable = vi.fn(async () => false);
    await expect(allocateUniqueId(occupied, unavailable, "allocation failed")).rejects.toThrow("allocation failed");
    expect(occupied).toHaveBeenCalledTimes(10);
    expect(unavailable).toHaveBeenCalledTimes(10);

    const availabilityFailure = vi.fn(async () => { throw new Error("storage failed"); });
    await expect(allocateUniqueId(occupied, availabilityFailure, "allocation failed")).rejects.toThrow("storage failed");
    expect(availabilityFailure).toHaveBeenCalledOnce();
  });

  it("creates a stable project ID from the canonical root", () => {
    expect(createProjectId("/workspace/example")).toBe(createProjectId("/workspace/example"));
    expect(createProjectId("/workspace/example")).not.toBe(createProjectId("/workspace/other"));
  });
});
