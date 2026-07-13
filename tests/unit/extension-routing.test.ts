import { describe, expect, it, vi } from "vitest";
import { routeStopWork, shutdownUnattendedControllers } from "../../src/extension/index.js";
import type { RunRecord } from "../../src/shared/types.js";

function run(mode: "scheduled" | "proactive", runId: string): RunRecord {
  return { mode, runId } as unknown as RunRecord;
}

describe("extension unattended routing", () => {
  it("marks schedule and trigger controllers down before awaiting either", async () => {
    let releaseSchedule: (() => void) | undefined;
    let releaseTriggers: (() => void) | undefined;
    const shutdownScheduler = vi.fn(() => new Promise<void>((resolve) => { releaseSchedule = resolve; }));
    const shutdownTriggers = vi.fn(() => new Promise<void>((resolve) => { releaseTriggers = resolve; }));
    const shutdownWorker = vi.fn(async () => undefined);
    const interruptAttended = vi.fn(async () => undefined);
    const shutdown = shutdownUnattendedControllers({ shutdownScheduler, shutdownTriggers, shutdownWorker, interruptAttended });
    await Promise.resolve();
    expect(shutdownScheduler).toHaveBeenCalledOnce();
    expect(shutdownTriggers).toHaveBeenCalledOnce();
    expect(shutdownWorker).not.toHaveBeenCalled();
    expect(interruptAttended).not.toHaveBeenCalled();
    releaseSchedule?.();
    releaseTriggers?.();
    await shutdown;
    expect(shutdownWorker).toHaveBeenCalledOnce();
    expect(interruptAttended).toHaveBeenCalledOnce();
  });

  it("attempts every shutdown boundary before reporting aggregate failures", async () => {
    const shutdownScheduler = vi.fn(async () => { throw new Error("scheduler failed"); });
    const shutdownTriggers = vi.fn(async () => undefined);
    const shutdownWorker = vi.fn(async () => { throw new Error("worker failed"); });
    const interruptAttended = vi.fn(async () => undefined);
    await expect(shutdownUnattendedControllers({
      shutdownScheduler,
      shutdownTriggers,
      shutdownWorker,
      interruptAttended,
    })).rejects.toMatchObject({ errors: [expect.any(Error), expect.any(Error)] });
    expect(shutdownScheduler).toHaveBeenCalledOnce();
    expect(shutdownTriggers).toHaveBeenCalledOnce();
    expect(shutdownWorker).toHaveBeenCalledOnce();
    expect(interruptAttended).toHaveBeenCalledOnce();
  });

  it("stops the active proactive writer before a queued schedule", async () => {
    const stopSchedule = vi.fn(async () => "schedule_1234abcd");
    const stopTrigger = vi.fn(async () => "trigger_1234abcd");
    const result = await routeStopWork({
      activeRunId: "run_1234abcd",
      loadRun: vi.fn(async () => run("proactive", "run_1234abcd")),
      stopSchedule,
      stopTrigger,
      stopGoal: vi.fn(),
    });
    expect(result).toEqual({ kind: "trigger", id: "trigger_1234abcd" });
    expect(stopTrigger).toHaveBeenCalledWith("run_1234abcd");
    expect(stopSchedule).not.toHaveBeenCalled();
  });

  it("routes explicit workflow IDs before falling back to attended goals", async () => {
    const stopSchedule = vi.fn(async (id?: string) => id === "schedule_1234abcd" ? id : undefined);
    const stopTrigger = vi.fn(async (id?: string) => id === "trigger_1234abcd" ? id : undefined);
    const stopGoal = vi.fn(async (id?: string) => id ? run("proactive", id) : undefined);
    const loadRun = vi.fn(async () => undefined);

    await expect(routeStopWork({ requestedId: "schedule_1234abcd", loadRun, stopSchedule, stopTrigger, stopGoal }))
      .resolves.toEqual({ kind: "schedule", id: "schedule_1234abcd" });
    expect(stopTrigger).not.toHaveBeenCalled();
    await expect(routeStopWork({ requestedId: "trigger_1234abcd", loadRun, stopSchedule, stopTrigger, stopGoal }))
      .resolves.toEqual({ kind: "trigger", id: "trigger_1234abcd" });
    await expect(routeStopWork({ requestedId: "run_deadbeef", loadRun, stopSchedule, stopTrigger, stopGoal }))
      .resolves.toEqual({ kind: "goal", run: expect.objectContaining({ runId: "run_deadbeef" }) });
    expect(loadRun).not.toHaveBeenCalled();
  });

  it("falls back safely when the reported unattended active run is missing", async () => {
    const stopSchedule = vi.fn(async () => undefined);
    const stopTrigger = vi.fn(async () => undefined);
    const stopGoal = vi.fn(async () => undefined);
    await expect(routeStopWork({
      activeRunId: "run_1234abcd",
      loadRun: vi.fn(async () => undefined),
      stopSchedule,
      stopTrigger,
      stopGoal,
    })).resolves.toEqual({ kind: "goal", run: undefined });
    expect(stopSchedule).toHaveBeenCalledWith(undefined);
    expect(stopTrigger).toHaveBeenCalledWith(undefined);
    expect(stopGoal).toHaveBeenCalledWith(undefined);
  });

  it("stops the active scheduled writer before queued proactive work", async () => {
    const stopSchedule = vi.fn(async () => "schedule_1234abcd");
    const stopTrigger = vi.fn(async () => "trigger_1234abcd");
    const result = await routeStopWork({
      activeRunId: "run_1234abcd",
      loadRun: vi.fn(async () => run("scheduled", "run_1234abcd")),
      stopSchedule,
      stopTrigger,
      stopGoal: vi.fn(),
    });
    expect(result).toEqual({ kind: "schedule", id: "schedule_1234abcd" });
    expect(stopSchedule).toHaveBeenCalledWith("run_1234abcd");
    expect(stopTrigger).not.toHaveBeenCalled();
  });
});
