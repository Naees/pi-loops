import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { triggerSchedule } from "../../src/scheduler/coalescing.js";
import { ScheduleController, type SchedulerHost } from "../../src/scheduler/scheduler.js";
import { createProjectId } from "../../src/shared/ids.js";
import { acquireWriterLease, releaseWriterLease } from "../../src/storage/lease.js";
import { ScheduleStore, scheduleClaimLeasePath, scheduleExecutionLeasePath, scheduleLeasePath } from "../../src/storage/schedule-store.js";

const temporaryDirectories: string[] = [];
const claimFixture = join(process.cwd(), "scripts", "fixtures", "hold-schedule-claims.mjs");

function waitForChildExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Claim fixture did not exit"));
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function waitForChildReady(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      operation();
    };
    const timer = setTimeout(() => finish(() => reject(new Error("Claim fixture did not become ready"))), 5_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (output.includes("ready\n")) finish(resolve);
    });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("exit", (code) => {
      if (!output.includes("ready\n")) finish(() => reject(new Error(`Claim fixture exited before ready: ${code}`)));
    });
  });
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function expectClaimsReleased(dataRoot: string, projectId: string, scheduleId: string): Promise<void> {
  await vi.waitFor(async () => {
    const execution = await acquireWriterLease(scheduleExecutionLeasePath(dataRoot, projectId), 30_000);
    try {
      const occurrence = await acquireWriterLease(scheduleClaimLeasePath(dataRoot, projectId, scheduleId), 30_000);
      await releaseWriterLease(occurrence);
    } finally {
      await releaseWriterLease(execution);
    }
  }, { timeout: 1_000 });
}

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
    const { controller, host, dataRoot, project } = await harness();
    let finishFirst: ((value: { status: "finished" }) => void) | undefined;
    const first = new Promise<{ status: "finished" }>((resolve) => {
      finishFirst = resolve;
    });
    const runner = vi.fn()
      .mockImplementationOnce(async () => first)
      .mockResolvedValue({ status: "finished" as const });
    await controller.start(host, runner);
    const schedule = await controller.create({ expression: "every 5m", goal: "run checks" }, host);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await vi.waitFor(async () => {
      const stored = (await controller.list(host.cwd))[0];
      expect(stored).toEqual(expect.objectContaining({ state: "pending_coalesced", nextFireAt: "2026-07-12T12:25:00.000Z" }));
    });
    expect(runner).toHaveBeenCalledTimes(1);

    finishFirst?.({ status: "finished" });
    await vi.waitFor(async () => {
      expect(runner).toHaveBeenCalledTimes(2);
      expect((await controller.list(host.cwd))[0]).toEqual(expect.objectContaining({ state: "enabled" }));
    });
    const projectId = createProjectId(await realpath(project));
    await expectClaimsReleased(dataRoot, projectId, schedule.scheduleId);
    await controller.shutdown();
  });

  it("rolls back a coalesced replacement when shutdown wins its launch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T12:00:00.000Z"));
    const { host, project, dataRoot } = await harness();
    let hookCalls = 0;
    let replacementHookEntered: (() => void) | undefined;
    const hookEntered = new Promise<void>((resolve) => {
      replacementHookEntered = resolve;
    });
    let continueReplacement: (() => void) | undefined;
    const replacementGate = new Promise<void>((resolve) => {
      continueReplacement = resolve;
    });
    const controller = new ScheduleController({
      dataRoot,
      now: () => new Date(Date.now()),
      beforeOccurrenceLaunch: async () => {
        hookCalls += 1;
        if (hookCalls === 2) {
          replacementHookEntered?.();
          await replacementGate;
        }
      },
    });
    let finishFirst: ((value: { status: "finished" }) => void) | undefined;
    const runner = vi.fn(() => new Promise<{ status: "finished" }>((resolve) => {
      finishFirst = resolve;
    }));
    await controller.start(host, runner);
    const schedule = await controller.create({ expression: "every 5m", goal: "replacement shutdown" }, host);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await vi.waitFor(() => expect(runner).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    finishFirst?.({ status: "finished" });
    await hookEntered;

    const shuttingDown = controller.shutdown();
    continueReplacement?.();
    await shuttingDown;

    expect(runner).toHaveBeenCalledOnce();
    expect((await controller.list(host.cwd))[0]).toEqual(expect.objectContaining({
      state: "paused",
      pauseReason: "interrupted",
    }));
    const projectId = createProjectId(await realpath(project));
    await expectClaimsReleased(dataRoot, projectId, schedule.scheduleId);
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

  it("serializes different schedules across competing controllers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T12:00:00.000Z"));
    const { controller, host, dataRoot } = await harness();
    await controller.create({ expression: "in 1m", goal: "first project writer" }, host);
    await controller.create({ expression: "in 1m", goal: "second project writer" }, host);
    const contender = new ScheduleController({ dataRoot, now: () => new Date(Date.now()) });
    let concurrent = 0;
    let maximumConcurrent = 0;
    let calls = 0;
    let finishFirst: (() => void) | undefined;
    const first = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const runner = vi.fn(async () => {
      concurrent += 1;
      maximumConcurrent = Math.max(maximumConcurrent, concurrent);
      const call = calls++;
      if (call === 0) await first;
      concurrent -= 1;
      return { status: "finished" as const };
    });
    await controller.start(host, runner);
    await contender.start(host, runner);

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1));
    expect(maximumConcurrent).toBe(1);
    finishFirst?.();
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(2));
    expect(maximumConcurrent).toBe(1);
    await Promise.all([controller.shutdown(), contender.shutdown()]);
  });

  it("retries startup reconciliation after schedule-store contention", async () => {
    const { controller, host, project, dataRoot } = await harness();
    const projectId = createProjectId(await realpath(project));
    const lease = await acquireWriterLease(scheduleLeasePath(dataRoot, projectId), 30_000);
    let started = false;
    const starting = controller.start(host, vi.fn(async () => ({ status: "finished" as const }))).then(() => {
      started = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(started).toBe(false);
    await releaseWriterLease(lease);
    await starting;
    expect(started).toBe(true);
    await controller.shutdown();
  }, 3_000);

  it("does not reconcile or relaunch another controller's live occurrence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T12:00:00.000Z"));
    const { controller, host, dataRoot, project } = await harness();
    let finish: ((value: { status: "finished" }) => void) | undefined;
    const firstRunner = vi.fn((_schedule: unknown, _runId: string) => new Promise<{ status: "finished" }>((resolve) => {
      finish = resolve;
    }));
    const secondRunner = vi.fn(async () => ({ status: "finished" as const }));
    await controller.start(host, firstRunner);
    const schedule = await controller.create({ expression: "in 1m", goal: "single owner" }, host);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(firstRunner).toHaveBeenCalledOnce());

    const contender = new ScheduleController({ dataRoot, now: () => new Date(Date.now()) });
    await contender.start(host, secondRunner);
    expect((await contender.list(host.cwd)).find((item) => item.scheduleId === schedule.scheduleId)).toEqual(
      expect.objectContaining({ state: "running", activeRunId: firstRunner.mock.calls[0]?.[1] }),
    );
    expect(secondRunner).not.toHaveBeenCalled();

    finish?.({ status: "finished" });
    await vi.waitFor(async () => {
      expect((await contender.list(host.cwd)).find((item) => item.scheduleId === schedule.scheduleId)).toEqual(
        expect.objectContaining({ state: "paused", pauseReason: "completed" }),
      );
    });
    expect(secondRunner).not.toHaveBeenCalled();
    const projectId = createProjectId(await realpath(project));
    await expectClaimsReleased(dataRoot, projectId, schedule.scheduleId);
    await Promise.all([controller.shutdown(), contender.shutdown()]);
  });

  it("reconciles an abandoned foreign occurrence after its claim is released", async () => {
    let nowMs = Date.parse("2026-07-12T12:00:00.000Z");
    const { host, project, dataRoot } = await harness();
    const controller = new ScheduleController({ dataRoot, now: () => new Date(nowMs), claimRecheckMs: 20 });
    const schedule = await controller.create({ expression: "in 1m", goal: "recover claim" }, host);
    nowMs += 60_000;
    const projectId = createProjectId(await realpath(project));
    const scheduleLease = await acquireWriterLease(scheduleLeasePath(dataRoot, projectId), 30_000);
    try {
      const store = new ScheduleStore(dataRoot, projectId, scheduleLease);
      const running = triggerSchedule(schedule, "run_1234abcd", new Date(nowMs));
      if (running.action !== "start") throw new Error("Expected schedule to start");
      await store.save(running.schedule);
    } finally {
      await releaseWriterLease(scheduleLease);
    }
    const claim = await acquireWriterLease(scheduleClaimLeasePath(dataRoot, projectId, schedule.scheduleId), 30_000);
    const runner = vi.fn(async () => ({ status: "finished" as const }));
    try {
      await controller.start(host, runner);
      expect((await controller.list(host.cwd))[0]).toEqual(expect.objectContaining({ state: "running" }));
      expect(runner).not.toHaveBeenCalled();
      await releaseWriterLease(claim);
      await vi.waitFor(async () => {
        expect((await controller.list(host.cwd))[0]).toEqual(expect.objectContaining({
          state: "paused",
          pauseReason: "interrupted",
        }));
      }, { timeout: 1_000 });
      expect(runner).not.toHaveBeenCalled();
    } finally {
      await releaseWriterLease(claim).catch(() => undefined);
      await controller.shutdown();
    }
  });

  it("takes over an abandoned occurrence after a claimant process is killed", async () => {
    let nowMs = Date.parse("2026-07-12T12:00:00.000Z");
    const { host, project, dataRoot } = await harness();
    const controller = new ScheduleController({
      dataRoot,
      now: () => new Date(nowMs),
      claimLeaseStaleMs: 2_000,
      claimRecheckMs: 50,
    });
    const schedule = await controller.create({ expression: "in 1m", goal: "recover killed claimant" }, host);
    nowMs += 60_000;
    const projectId = createProjectId(await realpath(project));
    const scheduleLease = await acquireWriterLease(scheduleLeasePath(dataRoot, projectId), 30_000);
    try {
      const store = new ScheduleStore(dataRoot, projectId, scheduleLease);
      const running = triggerSchedule(schedule, "run_1234abcd", new Date(nowMs));
      if (running.action !== "start") throw new Error("Expected schedule to start");
      await store.save(running.schedule);
    } finally {
      await releaseWriterLease(scheduleLease);
    }
    const child = spawn(process.execPath, [
      claimFixture,
      scheduleExecutionLeasePath(dataRoot, projectId),
      scheduleClaimLeasePath(dataRoot, projectId, schedule.scheduleId),
    ], { stdio: ["pipe", "pipe", "pipe"] });
    try {
      await waitForChildReady(child);
      await controller.start(host, vi.fn(async () => ({ status: "finished" as const })));
      expect((await controller.list(host.cwd))[0]).toEqual(expect.objectContaining({ state: "running" }));
      child.kill("SIGKILL");
      await waitForChildExit(child);
      await vi.waitFor(async () => {
        expect((await controller.list(host.cwd))[0]).toEqual(expect.objectContaining({
          state: "paused",
          pauseReason: "interrupted",
        }));
      }, { timeout: 5_000, interval: 50 });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await controller.shutdown();
    }
  }, 8_000);

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

  it("aborts an in-flight occurrence when its cross-process claim is compromised", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T12:00:00.000Z"));
    const { host, project, dataRoot } = await harness();
    const controller = new ScheduleController({
      dataRoot,
      now: () => new Date(Date.now()),
      claimLeaseStaleMs: 2_000,
      claimRecheckMs: 20,
    });
    let observedSignal: AbortSignal | undefined;
    const runner = vi.fn((_schedule, _runId, signal: AbortSignal) => new Promise<{ status: "interrupted" }>((resolve) => {
      observedSignal = signal;
      signal.addEventListener("abort", () => resolve({ status: "interrupted" }), { once: true });
    }));
    await controller.start(host, runner);
    const schedule = await controller.create({ expression: "in 1m", goal: "guard occurrence" }, host);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(runner).toHaveBeenCalledOnce());
    const projectId = createProjectId(await realpath(project));

    await rm(`${scheduleClaimLeasePath(dataRoot, projectId, schedule.scheduleId)}.lock`, { recursive: true, force: true });
    await vi.advanceTimersByTimeAsync(1_000);

    await vi.waitFor(async () => {
      expect(observedSignal?.aborted).toBe(true);
      expect((await controller.list(host.cwd))[0]).toEqual(expect.objectContaining({
        state: "paused",
        pauseReason: "interrupted",
      }));
    });
    await controller.shutdown();
  });

  it("rolls back persisted claims when pre-launch preparation fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T12:00:00.000Z"));
    const { host, project, dataRoot } = await harness();
    const controller = new ScheduleController({
      dataRoot,
      now: () => new Date(Date.now()),
      beforeOccurrenceLaunch: async () => {
        throw new Error("pre-launch failed");
      },
    });
    const runner = vi.fn(async () => ({ status: "finished" as const }));
    await controller.start(host, runner);
    const schedule = await controller.create({ expression: "in 1m", goal: "pre-launch rollback" }, host);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(runner).not.toHaveBeenCalled();
    await vi.waitFor(async () => {
      expect((await controller.list(host.cwd))[0]).toEqual(expect.objectContaining({
        state: "paused",
        pauseReason: "interrupted",
      }));
    });
    const projectId = createProjectId(await realpath(project));
    await expectClaimsReleased(dataRoot, projectId, schedule.scheduleId);
    await controller.shutdown();
  });

  it("rolls back a persisted claim when shutdown wins before launch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T12:00:00.000Z"));
    const { host, project, dataRoot } = await harness();
    let enterLaunch: (() => void) | undefined;
    const launchEntered = new Promise<void>((resolve) => {
      enterLaunch = resolve;
    });
    let continueLaunch: (() => void) | undefined;
    const launchGate = new Promise<void>((resolve) => {
      continueLaunch = resolve;
    });
    const controller = new ScheduleController({
      dataRoot,
      now: () => new Date(Date.now()),
      beforeOccurrenceLaunch: async () => {
        enterLaunch?.();
        await launchGate;
      },
    });
    const runner = vi.fn(async () => ({ status: "finished" as const }));
    await controller.start(host, runner);
    const schedule = await controller.create({ expression: "in 1m", goal: "shutdown race" }, host);

    const advancing = vi.advanceTimersByTimeAsync(60_000);
    await launchEntered;
    const shuttingDown = controller.shutdown();
    continueLaunch?.();
    await Promise.all([advancing, shuttingDown]);

    expect(runner).not.toHaveBeenCalled();
    expect((await controller.list(host.cwd))[0]).toEqual(expect.objectContaining({
      state: "paused",
      pauseReason: "interrupted",
    }));
    const projectId = createProjectId(await realpath(project));
    await expectClaimsReleased(dataRoot, projectId, schedule.scheduleId);
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
