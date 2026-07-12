import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScheduleController, type SchedulerHost } from "../../src/scheduler/scheduler.js";

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
  return { controller, host, notifications, project };
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

  it("aborts active occurrences during shutdown", async () => {
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
  });
});
