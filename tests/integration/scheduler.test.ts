import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScheduleController, type SchedulerHost } from "../../src/scheduler/scheduler.js";
import { createProjectId } from "../../src/shared/ids.js";
import { acquireWriterLease, releaseWriterLease } from "../../src/storage/lease.js";
import { scheduleLeasePath } from "../../src/storage/schedule-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function harness() {
  const dataRoot = await mkdtemp(join(tmpdir(), "pi-loops-scheduler-data-"));
  const project = await mkdtemp(join(tmpdir(), "pi-loops-scheduler-project-"));
  temporaryDirectories.push(dataRoot, project);
  const notifications: string[] = [];
  const host: SchedulerHost = {
    cwd: project,
    notify(message) {
      notifications.push(message);
    },
  };
  const controller = new ScheduleController({ dataRoot, now: () => new Date(Date.now()) });
  return { controller, host, notifications, project, dataRoot };
}

describe("schedule controller", () => {
  it("fires a future one-off once and retains it as completed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T12:00:00.000Z"));
    const { controller, host } = await harness();
    const runner = vi.fn(async () => ({ status: "finished" as const }));
    await controller.start(host, runner);
    const schedule = await controller.create({ expression: "in 1m", goal: "run checks" }, host);

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(async () => {
      expect(runner).toHaveBeenCalledOnce();
      const stored = (await controller.list(host.cwd)).find((item) => item.scheduleId === schedule.scheduleId);
      expect(stored).toEqual(expect.objectContaining({ state: "paused", pauseReason: "completed" }));
    });
    await controller.shutdown();
  });

  it("coalesces recurring overlap into exactly one replacement", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T12:00:00.000Z"));
    const { controller, host } = await harness();
    let finishFirst: ((value: { status: "finished" }) => void) | undefined;
    const first = new Promise<{ status: "finished" }>((resolve) => {
      finishFirst = resolve;
    });
    const runner = vi.fn()
      .mockImplementationOnce(async () => first)
      .mockResolvedValue({ status: "finished" as const });
    await controller.start(host, runner);
    await controller.create({ expression: "every 5m", goal: "run checks" }, host);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await vi.waitFor(async () => {
      const stored = (await controller.list(host.cwd))[0];
      expect(stored).toEqual(expect.objectContaining({ state: "pending_coalesced", nextFireAt: "2026-07-12T12:25:00.000Z" }));
    });
    expect(runner).toHaveBeenCalledTimes(1);

    finishFirst?.({ status: "finished" });
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(2));
    await controller.shutdown();
  });

  it("discards missed startup occurrences instead of replaying them", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T12:00:00.000Z"));
    const { controller, host } = await harness();
    const once = await controller.create({ expression: "in 5m", goal: "one-off" }, host);
    const recurring = await controller.create({ expression: "every 5m", goal: "recurring" }, host);
    vi.setSystemTime(new Date("2026-07-12T12:16:00.000Z"));
    const runner = vi.fn(async () => ({ status: "finished" as const }));

    await controller.start(host, runner);

    const schedules = await controller.list(host.cwd);
    expect(schedules.find((item) => item.scheduleId === once.scheduleId)).toEqual(expect.objectContaining({ state: "paused", pauseReason: "missed" }));
    expect(schedules.find((item) => item.scheduleId === recurring.scheduleId)?.nextFireAt).toBe("2026-07-12T12:20:00.000Z");
    expect(runner).not.toHaveBeenCalled();
    await controller.shutdown();
  });

  it("serializes schedules due at the same time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T12:00:00.000Z"));
    const { controller, host } = await harness();
    let finishFirst: ((value: { status: "finished" }) => void) | undefined;
    const first = new Promise<{ status: "finished" }>((resolve) => {
      finishFirst = resolve;
    });
    const runner = vi.fn().mockImplementationOnce(async () => first).mockResolvedValue({ status: "finished" as const });
    await controller.start(host, runner);
    await controller.create({ expression: "in 1m", goal: "first" }, host);
    await controller.create({ expression: "in 1m", goal: "second" }, host);

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1));
    finishFirst?.({ status: "finished" });
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(2));
    await controller.shutdown();
  });

  it("keeps retrying after repeated schedule-lease contention", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T12:00:00.000Z"));
    const { controller, host, notifications, project, dataRoot } = await harness();
    const runner = vi.fn(async () => ({ status: "finished" as const }));
    await controller.start(host, runner);
    await controller.create({ expression: "in 1m", goal: "retry contention" }, host);
    await vi.advanceTimersByTimeAsync(59_000);
    const projectId = createProjectId(await realpath(project));
    const lease = await acquireWriterLease(scheduleLeasePath(dataRoot, projectId), 30_000);
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(notifications.filter((message) => message.includes("scheduler failed"))).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(notifications.filter((message) => message.includes("scheduler failed"))).toHaveLength(2));
      expect(runner).not.toHaveBeenCalled();
      await releaseWriterLease(lease);
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(runner).toHaveBeenCalledOnce());
    } finally {
      await releaseWriterLease(lease).catch(() => undefined);
      await controller.shutdown();
    }
  });

  it("retries settlement without losing a completed occurrence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T12:00:00.000Z"));
    const { controller, host, notifications, project, dataRoot } = await harness();
    let finish: ((value: { status: "finished" }) => void) | undefined;
    const runner = vi.fn(() => new Promise<{ status: "finished" }>((resolve) => {
      finish = resolve;
    }));
    await controller.start(host, runner);
    const schedule = await controller.create({ expression: "in 1m", goal: "persist result" }, host);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(runner).toHaveBeenCalledOnce());

    const projectId = createProjectId(await realpath(project));
    const lease = await acquireWriterLease(scheduleLeasePath(dataRoot, projectId), 30_000);
    try {
      finish?.({ status: "finished" });
      await vi.waitFor(() => expect(notifications).toContain(`${schedule.scheduleId}: waiting to persist scheduled occurrence result`));
      expect((await controller.list(host.cwd))[0]).toEqual(expect.objectContaining({
        state: "running",
        activeRunId: expect.any(String),
      }));
      await releaseWriterLease(lease);
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(async () => {
        expect((await controller.list(host.cwd))[0]).toEqual(expect.objectContaining({ state: "paused", pauseReason: "completed" }));
      });
    } finally {
      await releaseWriterLease(lease).catch(() => undefined);
      await controller.shutdown();
    }
  });

  it("persists an explicitly stopped occurrence as interrupted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T12:00:00.000Z"));
    const { controller, host } = await harness();
    const runner = vi.fn((_schedule, _runId, signal: AbortSignal) => new Promise<{ status: "interrupted" }>((resolve) => {
      signal.addEventListener("abort", () => resolve({ status: "interrupted" }), { once: true });
    }));
    await controller.start(host, runner);
    const schedule = await controller.create({ expression: "in 1m", goal: "stop safely" }, host);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(runner).toHaveBeenCalledOnce());

    await expect(controller.stop(schedule.scheduleId, host.cwd)).resolves.toBe(schedule.scheduleId);
    const stored = (await controller.list(host.cwd))[0];
    expect(stored).toEqual(expect.objectContaining({ state: "paused", pauseReason: "interrupted" }));
    expect(stored).not.toHaveProperty("activeRunId");
    await expect(controller.delete(schedule.scheduleId, host.cwd)).resolves.toBeUndefined();
    await controller.shutdown();
  });

  it("aborts active occurrences during shutdown and persists interruption", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T12:00:00.000Z"));
    const { controller, host } = await harness();
    const runner = vi.fn((_schedule, _runId, signal: AbortSignal) => new Promise<{ status: "interrupted" }>((resolve) => {
      signal.addEventListener("abort", () => resolve({ status: "interrupted" }), { once: true });
    }));
    await controller.start(host, runner);
    await controller.create({ expression: "in 1m", goal: "run checks" }, host);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(runner).toHaveBeenCalledOnce());

    await controller.shutdown();

    expect(runner).toHaveBeenCalledOnce();
    expect(runner.mock.calls[0]?.[2].aborted).toBe(true);
    const stored = (await controller.list(host.cwd))[0];
    expect(stored).toEqual(expect.objectContaining({ state: "paused", pauseReason: "interrupted" }));
    expect(stored).not.toHaveProperty("activeRunId");
  });
});
