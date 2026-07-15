import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import type { FSWatcher } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { transitionRun } from "../../src/controller/state-machine.js";
import { createProjectId } from "../../src/shared/ids.js";
import type { RunRecord, TriggerRecord } from "../../src/shared/types.js";
import { acquireWriterLease, releaseWriterLease, type WriterLease } from "../../src/storage/lease.js";
import { RunStore, writerLeasePath } from "../../src/storage/run-store.js";
import { TriggerStore, triggerClaimLeasePath, triggerLeasePath } from "../../src/storage/trigger-store.js";
import { TriggerController, type TriggerHost } from "../../src/triggers/controller.js";
import type { WatchFunction } from "../../src/triggers/filesystem.js";

const temporary: string[] = [];
const claimFixture = join(process.cwd(), "scripts", "fixtures", "hold-trigger-claim.mjs");
const leases: WriterLease[] = [];
afterEach(async () => {
  await Promise.all(leases.splice(0).map((lease) => releaseWriterLease(lease).catch(() => undefined)));
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function harness() {
  const dataRoot = await mkdtemp(join(tmpdir(), "pi-loops-trigger-controller-"));
  const projectDirectory = await mkdtemp(join(tmpdir(), "pi-loops-trigger-project-"));
  temporary.push(dataRoot, projectDirectory);
  const projectRoot = await realpath(projectDirectory);
  const projectId = createProjectId(projectRoot);
  const notifications: string[] = [];
  const host: TriggerHost = { cwd: projectRoot, notify: (message) => notifications.push(message) };
  return { dataRoot, projectRoot, projectId, notifications, host };
}

function runningTrigger(projectRoot: string, projectId: string): TriggerRecord {
  return {
    schemaVersion: 1,
    triggerId: "trigger_1234abcd",
    projectId,
    projectRoot,
    state: "running",
    goal: "run checks",
    constraints: [],
    verifierCommands: [],
    budget: { maxActiveMs: 60_000, maxCycles: 3, stallThreshold: 2 },
    source: { kind: "event" },
    activeRunId: "run_1234abcd",
    lastTriggeredAt: "2026-07-12T12:00:00.000Z",
    createdAt: "2026-07-12T12:00:00.000Z",
    updatedAt: "2026-07-12T12:00:00.000Z",
  };
}

async function saveTrigger(dataRoot: string, projectId: string, trigger: TriggerRecord): Promise<void> {
  const lease = await acquireWriterLease(triggerLeasePath(dataRoot, projectId), 30_000);
  try {
    await new TriggerStore(dataRoot, projectId, lease).save(trigger);
  } finally {
    await releaseWriterLease(lease);
  }
}

function fakeWatchHarness(): {
  readonly watch: WatchFunction;
  readonly listeners: ((eventType: string, filename: string | Buffer | null) => void)[];
  readonly watchers: FSWatcher[];
} {
  const listeners: ((eventType: string, filename: string | Buffer | null) => void)[] = [];
  const watchers: FSWatcher[] = [];
  return {
    listeners,
    watchers,
    watch: (_path, _options, listener) => {
      listeners.push(listener);
      const watcher = Object.assign(new EventEmitter(), { close: vi.fn(), unref: vi.fn() }) as unknown as FSWatcher;
      watchers.push(watcher);
      return watcher;
    },
  };
}

describe("trigger controller", () => {
  it("coalesces a trigger storm into exactly one replacement occurrence", async () => {
    const { dataRoot, host } = await harness();
    const controller = new TriggerController({ dataRoot });
    let finishFirst: ((result: { status: "finished" }) => void) | undefined;
    const runner = vi.fn((_trigger, _runId, _signal, _kind) => runner.mock.calls.length === 1
      ? new Promise<{ status: "finished" }>((resolve) => { finishFirst = resolve; })
      : Promise.resolve({ status: "finished" as const }));
    await controller.start(host, runner);
    const trigger = await controller.create({ source: { kind: "event" }, goal: "run checks" }, host);

    await expect(controller.fire(trigger.triggerId, host.cwd)).resolves.toBe("started");
    for (let index = 0; index < 50; index += 1) {
      await expect(controller.fire(trigger.triggerId, host.cwd)).resolves.toBe("coalesced");
    }
    expect((await controller.list(host.cwd))[0]).toEqual(expect.objectContaining({ state: "pending_coalesced" }));
    await expect(controller.delete(trigger.triggerId, host.cwd)).rejects.toThrow("Stop the active proactive run");
    finishFirst?.({ status: "finished" });
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(2));
    await vi.waitFor(async () => expect((await controller.list(host.cwd))[0]).toEqual(expect.objectContaining({ state: "enabled" })));
    expect(runner.mock.calls[0]?.[1]).not.toBe(runner.mock.calls[1]?.[1]);
    await controller.shutdown();
  });

  it("retries occurrence settlement while the trigger store lease is contended", async () => {
    const { dataRoot, projectId, host, notifications } = await harness();
    const controller = new TriggerController({ dataRoot, settlementRetryMs: 10 });
    let finish: ((result: { status: "finished" }) => void) | undefined;
    const runner = vi.fn(() => new Promise<{ status: "finished" }>((resolve) => { finish = resolve; }));
    await controller.start(host, runner);
    const trigger = await controller.create({ source: { kind: "event" }, goal: "run checks" }, host);
    await expect(controller.fire(trigger.triggerId, host.cwd)).resolves.toBe("started");

    const storeLease = await acquireWriterLease(triggerLeasePath(dataRoot, projectId), 30_000);
    leases.push(storeLease);
    finish?.({ status: "finished" });
    await vi.waitFor(() => expect(notifications).toContain(`${trigger.triggerId}: waiting to persist proactive occurrence result`));
    expect((await controller.list(host.cwd))[0]).toEqual(expect.objectContaining({ state: "running" }));

    await releaseWriterLease(storeLease);
    await vi.waitFor(async () => expect((await controller.list(host.cwd))[0]).toEqual(expect.objectContaining({ state: "enabled" })));
    expect(notifications.some((message) => message.includes("settlement failed"))).toBe(false);
    await controller.shutdown();
  });

  it("does not consume an event ID when delivery fails", async () => {
    const { dataRoot, host } = await harness();
    const controller = new TriggerController({ dataRoot });
    await controller.start(host, vi.fn(async () => ({ status: "finished" as const })));
    await expect(controller.fireEvent("trigger_deadbeef", host.cwd, "retryable-event")).rejects.toThrow("Event trigger not found");
    await expect(controller.fireEvent("trigger_deadbeef", host.cwd, "retryable-event")).rejects.toThrow("Event trigger not found");
    await controller.shutdown();
  });

  it("bounds simultaneous unknown event admission", async () => {
    const { dataRoot, host } = await harness();
    const controller = new TriggerController({ dataRoot });
    await controller.start(host, vi.fn(async () => ({ status: "finished" as const })));
    const deliveries = Array.from({ length: 100 }, (_, index) =>
      controller.fireEvent(`trigger_${index.toString(16).padStart(8, "0")}`, host.cwd));
    const results = await Promise.allSettled(deliveries);
    expect(results.filter((result) => result.status === "rejected" && String(result.reason).includes("ingress is at capacity")).length)
      .toBeGreaterThanOrEqual(36);
    await expect(controller.fireEvent("trigger_deadbeef", host.cwd)).rejects.toThrow("Event trigger not found");
    await controller.shutdown();
  });

  it("deduplicates a bounded source event ID", async () => {
    const { dataRoot, host } = await harness();
    const runner = vi.fn(async () => ({ status: "finished" as const }));
    const controller = new TriggerController({ dataRoot });
    await controller.start(host, runner);
    const trigger = await controller.create({ source: { kind: "event" }, goal: "run checks" }, host);

    await expect(controller.fireEvent(trigger.triggerId, host.cwd, "build-42")).resolves.toBe("started");
    await vi.waitFor(async () => expect((await controller.list(host.cwd))[0]?.state).toBe("enabled"));
    await expect(controller.fireEvent(trigger.triggerId, host.cwd, "build-42")).resolves.toBe("ignored");
    expect(runner).toHaveBeenCalledOnce();
    await controller.shutdown();
  });

  it("bounds an event-bus storm to one running and one pending occurrence", async () => {
    const { dataRoot, host } = await harness();
    let release: (() => void) | undefined;
    const runner = vi.fn(async () => {
      if (runner.mock.calls.length === 1) await new Promise<void>((resolve) => { release = resolve; });
      return { status: "finished" as const };
    });
    const controller = new TriggerController({ dataRoot, now: () => new Date("2026-07-12T12:00:00.000Z") });
    await controller.start(host, runner);
    const trigger = await controller.create({ source: { kind: "event" }, goal: "run checks" }, host);

    const results = await Promise.all(Array.from({ length: 100 }, () => controller.fireEvent(trigger.triggerId, host.cwd)));
    expect(results.filter((result) => result === "started")).toHaveLength(1);
    expect(results.filter((result) => result === "coalesced")).toHaveLength(99);
    expect(runner).toHaveBeenCalledOnce();
    release?.();
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(2));
    await vi.waitFor(async () => expect((await controller.list(host.cwd))[0]?.state).toBe("enabled"));
    await controller.shutdown();
  });

  it("deduplicates the same filesystem delivery across competing controllers", async () => {
    const { dataRoot, host } = await harness();
    const firstWatch = fakeWatchHarness();
    const secondWatch = fakeWatchHarness();
    const first = new TriggerController({ dataRoot, now: () => new Date("2026-07-12T12:00:00.000Z"), watch: firstWatch.watch });
    const second = new TriggerController({ dataRoot, now: () => new Date("2026-07-12T12:00:00.000Z"), watch: secondWatch.watch });
    let release: (() => void) | undefined;
    const controlledRun = async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return { status: "finished" as const };
    };
    const runner = vi.fn(controlledRun);
    const competingRunner = vi.fn(controlledRun);
    await first.start(host, runner);
    await second.start(host, competingRunner);
    const trigger = await first.create({ source: { kind: "filesystem", path: ".", debounceMs: 100 }, goal: "run checks" }, host);

    const results = await Promise.all([
      first.fire(trigger.triggerId, host.cwd),
      second.fire(trigger.triggerId, host.cwd),
    ]);
    expect(results.sort()).toEqual(["ignored", "started"]);
    expect(runner.mock.calls.length + competingRunner.mock.calls.length).toBe(1);
    release?.();
    await vi.waitFor(async () => expect((await first.list(host.cwd))[0]?.state).toBe("enabled"));
    await first.shutdown();
    await second.shutdown();
  });

  it("coordinates competing controllers without overlapping one trigger definition", async () => {
    const { dataRoot, host } = await harness();
    const first = new TriggerController({ dataRoot });
    const second = new TriggerController({ dataRoot });
    let active = 0;
    let maximumActive = 0;
    let release: (() => void) | undefined;
    let invocations = 0;
    const controlledRun = async () => {
      invocations += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (invocations === 1) await new Promise<void>((resolve) => { release = resolve; });
      active -= 1;
      return { status: "finished" as const };
    };
    const runner = vi.fn(controlledRun);
    const competingRunner = vi.fn(controlledRun);
    await first.start(host, runner);
    await second.start(host, competingRunner);
    const trigger = await first.create({ source: { kind: "event" }, goal: "run checks" }, host);

    const results = await Promise.all([
      first.fire(trigger.triggerId, host.cwd),
      second.fire(trigger.triggerId, host.cwd),
    ]);
    expect(results).toContain("started");
    expect(runner.mock.calls.length + competingRunner.mock.calls.length).toBe(1);
    release?.();
    const expectedRuns = results.includes("coalesced") ? 2 : 1;
    await vi.waitFor(() => expect(runner.mock.calls.length + competingRunner.mock.calls.length).toBe(expectedRuns));
    await vi.waitFor(async () => expect((await first.list(host.cwd))[0]?.state).toBe("enabled"));
    expect(maximumActive).toBe(1);
    await first.shutdown();
    await second.shutdown();
  });

  it("pauses definitions stopped by trigger ID and rejects deletion while active", async () => {
    const { dataRoot, host } = await harness();
    const controller = new TriggerController({ dataRoot });
    const runner = vi.fn((_trigger, _runId, signal: AbortSignal) => new Promise<{ status: "interrupted" }>((resolve) => {
      signal.addEventListener("abort", () => resolve({ status: "interrupted" }), { once: true });
    }));
    await controller.start(host, runner);
    const trigger = await controller.create({ source: { kind: "event" }, goal: "run checks" }, host);
    await controller.fire(trigger.triggerId, host.cwd);
    await expect(controller.delete(trigger.triggerId, host.cwd)).rejects.toThrow("Stop the active proactive run");
    await expect(controller.stop(trigger.triggerId, host.cwd)).resolves.toBe(trigger.triggerId);
    expect((await controller.list(host.cwd))[0]).toEqual(expect.objectContaining({ state: "paused" }));
    await controller.delete(trigger.triggerId, host.cwd);
    expect(await controller.list(host.cwd)).toEqual([]);
    await controller.shutdown();
  });

  it("contends and takes over a stale trigger claim across a real process boundary", async () => {
    const { dataRoot, projectId, host } = await harness();
    const controller = new TriggerController({ dataRoot, claimLeaseStaleMs: 2_000 });
    const runner = vi.fn(async () => ({ status: "finished" as const }));
    await controller.start(host, runner);
    const trigger = await controller.create({ source: { kind: "event" }, goal: "run checks" }, host);
    const child = spawn(process.execPath, [claimFixture, triggerClaimLeasePath(dataRoot, projectId, trigger.triggerId)], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    await once(child.stdout, "data");
    await expect(controller.fire(trigger.triggerId, host.cwd)).resolves.toBe("ignored");
    expect(runner).not.toHaveBeenCalled();

    child.kill("SIGKILL");
    await once(child, "exit");
    await vi.waitFor(async () => {
      expect(await controller.fire(trigger.triggerId, host.cwd)).toBe("started");
    }, { timeout: 5_000, interval: 100 });
    await vi.waitFor(() => expect(runner).toHaveBeenCalledOnce(), { timeout: 10_000 });
    await vi.waitFor(async () => expect((await controller.list(host.cwd))[0]?.state).toBe("enabled"), { timeout: 10_000 });
    await controller.shutdown();
  }, 30_000);

  it("aborts on claim compromise and recovers the abandoned occurrence on the next fire", async () => {
    const { dataRoot, projectId, host } = await harness();
    const controller = new TriggerController({ dataRoot, claimLeaseStaleMs: 2_000 });
    let observedSignal: AbortSignal | undefined;
    let firstRunId: string | undefined;
    const runner = vi.fn(async (_trigger, runId: string, signal: AbortSignal) => {
      if (runner.mock.calls.length > 1) return { status: "finished" as const };
      firstRunId = runId;
      observedSignal = signal;
      return new Promise<{ status: "interrupted" }>((resolve) => {
        signal.addEventListener("abort", () => resolve({ status: "interrupted" }), { once: true });
      });
    });
    await controller.start(host, runner);
    const trigger = await controller.create({ source: { kind: "event" }, goal: "run checks" }, host);
    await expect(controller.fire(trigger.triggerId, host.cwd)).resolves.toBe("started");

    await rm(`${triggerClaimLeasePath(dataRoot, projectId, trigger.triggerId)}.lock`, { recursive: true, force: true });
    await vi.waitFor(() => expect(observedSignal?.aborted).toBe(true), { timeout: 4_000 });
    await controller.stop(firstRunId, host.cwd);
    await vi.waitFor(async () => expect((await controller.list(host.cwd))[0]?.state).toBe("running"));
    await expect(controller.fire(trigger.triggerId, host.cwd)).resolves.toBe("started");
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(2));
    await vi.waitFor(async () => expect((await controller.list(host.cwd))[0]?.state).toBe("enabled"));
    await controller.shutdown();
  });

  it("reconciles abandoned state but preserves a foreign live claimant", async () => {
    const abandoned = await harness();
    await saveTrigger(abandoned.dataRoot, abandoned.projectId, runningTrigger(abandoned.projectRoot, abandoned.projectId));
    const first = new TriggerController({ dataRoot: abandoned.dataRoot });
    await first.start(abandoned.host, vi.fn(async () => ({ status: "finished" as const })));
    expect((await first.list(abandoned.host.cwd))[0]).toEqual(expect.objectContaining({ state: "enabled" }));
    await first.shutdown();

    const live = await harness();
    const claim = await acquireWriterLease(triggerClaimLeasePath(live.dataRoot, live.projectId, "trigger_1234abcd"), 30_000);
    leases.push(claim);
    await saveTrigger(live.dataRoot, live.projectId, runningTrigger(live.projectRoot, live.projectId));
    const second = new TriggerController({ dataRoot: live.dataRoot });
    await second.start(live.host, vi.fn(async () => ({ status: "finished" as const })));
    expect((await second.list(live.host.cwd))[0]).toEqual(expect.objectContaining({ state: "running" }));
    await second.shutdown();
  });

  it("resumes the same proactive run occurrence", async () => {
    const { dataRoot, projectRoot, projectId, host } = await harness();
    const enabled: TriggerRecord = { ...runningTrigger(projectRoot, projectId), state: "enabled" };
    const mutable: { -readonly [Key in keyof TriggerRecord]: TriggerRecord[Key] } = { ...enabled };
    delete mutable.activeRunId;
    await saveTrigger(dataRoot, projectId, mutable);
    const createdAt = "2026-07-12T12:00:00.000Z";
    let run: RunRecord = {
      schemaVersion: 1,
      runId: "run_1234abcd",
      projectId,
      triggerId: enabled.triggerId,
      mode: "proactive",
      state: "configuring",
      goal: enabled.goal,
      constraints: [],
      verifierCommands: [],
      budget: enabled.budget,
      budgetEpoch: 1,
      budgetHistory: [],
      cycle: 1,
      totalCycles: 1,
      activeMs: 10,
      budgetDeadlineAt: "2026-07-12T13:00:00.000Z",
      equivalentFailures: 0,
      latestEvidence: [],
      worker: {
        repositoryRoot: projectRoot,
        baseCommit: "a".repeat(40),
        branch: "pi-loops/run_1234abcd",
        worktreePath: join(dataRoot, "worktree"),
        sessionDirectory: join(dataRoot, "sessions"),
        sessionId: "session-1",
        sessionFile: join(dataRoot, "sessions", "session.jsonl"),
        worktreeRetained: true,
      },
      createdAt,
      updatedAt: createdAt,
      transitions: [],
    };
    for (const state of ["preflight", "starting", "running", "interrupted"] as const) {
      run = transitionRun(run, state, `to ${state}`, new Date(Date.parse(run.updatedAt) + 1));
    }
    const runLease = await acquireWriterLease(writerLeasePath(dataRoot, projectId), 30_000);
    try {
      await new RunStore(dataRoot, projectId, runLease).save(run);
    } finally {
      await releaseWriterLease(runLease);
    }
    const runner = vi.fn(async () => ({ status: "finished" as const }));
    const controller = new TriggerController({ dataRoot, now: () => new Date("2026-07-12T12:10:00.000Z") });
    await controller.start(host, runner);

    await controller.resumeOccurrence(enabled.triggerId, run.runId, host.cwd, "inspect the generated files");
    await vi.waitFor(() => expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({ triggerId: enabled.triggerId }),
      run.runId,
      expect.any(AbortSignal),
      "restart",
      "inspect the generated files",
    ));
    await vi.waitFor(async () => expect((await controller.list(host.cwd))[0]?.state).toBe("enabled"));
    await controller.shutdown();
  });

  it("launches a persisted filesystem definition after a debounced change", async () => {
    const { dataRoot, projectRoot, host } = await harness();
    const runner = vi.fn(async () => ({ status: "finished" as const }));
    const fake = fakeWatchHarness();
    const controller = new TriggerController({ dataRoot, watch: fake.watch });
    await controller.start(host, runner);
    const trigger = await controller.create({
      source: { kind: "filesystem", path: ".", debounceMs: 100 },
      goal: "run checks",
    }, host);

    await writeFile(join(projectRoot, "changed.txt"), "changed\n");
    fake.listeners[0]?.("change", "changed.txt");
    await vi.waitFor(() => expect(runner).toHaveBeenCalledOnce(), { timeout: 4_000 });
    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({ triggerId: trigger.triggerId, source: expect.objectContaining({ kind: "filesystem" }) }),
      expect.stringMatching(/^run_[0-9a-f]{8}$/),
      expect.any(AbortSignal),
      "start",
    );
    await vi.waitFor(async () => expect((await controller.list(host.cwd))[0]?.state).toBe("enabled"));
    await controller.stop(trigger.triggerId, host.cwd);
    await writeFile(join(projectRoot, "paused-change.txt"), "paused\n");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(runner).toHaveBeenCalledOnce();
    await controller.enable(trigger.triggerId, host.cwd);
    await writeFile(join(projectRoot, "resumed-change.txt"), "resumed\n");
    fake.listeners[1]?.("change", "resumed-change.txt");
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(2), { timeout: 4_000 });
    await controller.shutdown();
  });

  it("persists a runtime filesystem watcher failure as paused", async () => {
    const { dataRoot, host, notifications } = await harness();
    const fake = fakeWatchHarness();
    const controller = new TriggerController({ dataRoot, watch: fake.watch });
    await controller.start(host, vi.fn(async () => ({ status: "finished" as const })));
    const trigger = await controller.create({ source: { kind: "filesystem", path: "." }, goal: "run checks" }, host);

    fake.watchers[0]?.emit("error", new Error("watch failed"));
    await vi.waitFor(async () => expect((await controller.list(host.cwd))[0]).toEqual(expect.objectContaining({ state: "paused" })));
    expect(notifications.some((message) => message.includes(`${trigger.triggerId}: filesystem trigger failed — watch failed`))).toBe(true);
    expect(fake.watchers[0]?.close).toHaveBeenCalledOnce();
    await controller.shutdown();
  });

  it("persists an enabled filesystem definition as paused when startup cannot watch it", async () => {
    const { dataRoot, projectRoot, projectId, host, notifications } = await harness();
    const stored: { -readonly [Key in keyof TriggerRecord]: TriggerRecord[Key] } = {
      ...runningTrigger(projectRoot, projectId),
      state: "enabled",
      source: { kind: "filesystem", relativePath: "missing", debounceMs: 100 },
    };
    delete stored.activeRunId;
    await saveTrigger(dataRoot, projectId, stored);
    const controller = new TriggerController({ dataRoot });

    await expect(controller.start(host, vi.fn(async () => ({ status: "finished" as const })))).resolves.toBeUndefined();
    expect((await controller.list(host.cwd))[0]).toEqual(expect.objectContaining({ state: "paused" }));
    expect(notifications.some((message) => message.includes("filesystem watcher could not start"))).toBe(true);
    await controller.shutdown();
  });

  it("rolls a failed filesystem re-arm back to paused and keeps other triggers available", async () => {
    const { dataRoot, projectRoot, host } = await harness();
    await mkdir(join(projectRoot, "watched"));
    const controller = new TriggerController({ dataRoot });
    await controller.start(host, vi.fn(async () => ({ status: "finished" as const })));
    const filesystem = await controller.create({ source: { kind: "filesystem", path: "watched" }, goal: "run checks" }, host);
    const event = await controller.create({ source: { kind: "event" }, goal: "handle event" }, host);
    await controller.stop(filesystem.triggerId, host.cwd);
    await rm(join(projectRoot, "watched"), { recursive: true });
    await expect(controller.enable(filesystem.triggerId, host.cwd)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await controller.list(host.cwd)).find((item) => item.triggerId === filesystem.triggerId)?.state).toBe("paused");
    await controller.shutdown();

    const restarted = new TriggerController({ dataRoot });
    await expect(restarted.start(host, vi.fn(async () => ({ status: "finished" as const })))).resolves.toBeUndefined();
    await expect(restarted.fireEvent(event.triggerId, host.cwd)).resolves.toBe("started");
    await restarted.shutdown();
  });

  it("validates project binding, IDs, and lifecycle", async () => {
    const { dataRoot, host } = await harness();
    const controller = new TriggerController({ dataRoot });
    await expect(controller.fire("invalid", host.cwd)).rejects.toThrow("Invalid trigger ID");
    await controller.start(host, vi.fn(async () => ({ status: "finished" as const })));
    await expect(controller.start(host, vi.fn())).rejects.toThrow("already started");
    const trigger = await controller.create({ source: { kind: "event" }, goal: "run checks" }, host);
    await expect(controller.fire("trigger_deadbeef", host.cwd)).rejects.toThrow("Trigger not found");
    await expect(controller.stop("run_deadbeef", host.cwd)).resolves.toBeUndefined();
    await expect(controller.stop(trigger.triggerId, host.cwd)).resolves.toBe(trigger.triggerId);
    expect((await controller.list(host.cwd))[0]?.state).toBe("paused");
    await expect(controller.fire(trigger.triggerId, host.cwd)).resolves.toBe("ignored");
    await controller.enable(trigger.triggerId, host.cwd);
    expect((await controller.list(host.cwd))[0]?.state).toBe("enabled");
    await controller.shutdown();
    await expect(controller.fire(trigger.triggerId, host.cwd)).rejects.toThrow("not running for this project");
    await expect(controller.shutdown()).resolves.toBeUndefined();
  });
});
