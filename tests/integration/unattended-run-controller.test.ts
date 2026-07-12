import { spawnSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UnattendedRunController, type UnattendedRunHost } from "../../src/controller/unattended-run-controller.js";
import type { CompletionEvaluator } from "../../src/evidence/evaluator.js";
import { createProjectId } from "../../src/shared/ids.js";
import type { RunRecord, ScheduleRecord } from "../../src/shared/types.js";
import { acquireControllerWriterLock, releaseControllerWriterLock, repositoryWriterLeasePath, resolveRepositoryLockIdentity } from "../../src/storage/controller-writer-lock.js";
import { acquireWriterLease, releaseWriterLease } from "../../src/storage/lease.js";
import { RunStore, writerLeasePath } from "../../src/storage/run-store.js";
import { DirtyRepositoryError, NonGitRepositoryError, WorktreeNeedsUserError, type ManagedWorktree } from "../../src/worker/git-worktree.js";
import { WorkerInteractionRequiredError, type WorkerLaunchSpec } from "../../src/worker/rpc-worker-manager.js";
import type { ParentWorkerUi } from "../../src/ui/worker-ui-relay.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function harness() {
  const dataRoot = await mkdtemp(join(tmpdir(), "pi-loops-unattended-data-"));
  const projectDirectory = await mkdtemp(join(tmpdir(), "pi-loops-unattended-project-"));
  temporaryDirectories.push(dataRoot, projectDirectory);
  const projectRoot = await realpath(projectDirectory);
  const initialized = spawnSync("git", ["init", "-q"], { cwd: projectRoot, encoding: "utf8", shell: false });
  if (initialized.status !== 0) throw new Error(initialized.stderr);
  const projectId = createProjectId(projectRoot);
  const entries: RunRecord[] = [];
  const host: UnattendedRunHost = {
    cwd: projectRoot,
    ui: {
      hasUI: true,
      confirm: vi.fn(async () => true),
      select: vi.fn(async () => undefined),
      input: vi.fn(async () => undefined),
      editor: vi.fn(async () => undefined),
      notify: vi.fn(),
    },
    notify: vi.fn(),
    appendRunEntry(run) {
      entries.push(run);
    },
  };
  const schedule: ScheduleRecord = {
    schemaVersion: 1,
    scheduleId: "schedule_1234abcd",
    projectId,
    projectRoot,
    state: "running",
    goal: "produce a reviewable change",
    constraints: [],
    verifierCommands: [],
    budget: { maxActiveMs: 60_000, maxCycles: 3, stallThreshold: 2 },
    expression: "in 1m",
    normalizedExpression: "in 1 minute",
    timing: { kind: "once", fireAt: "2026-07-12T12:01:00.000Z" },
    activeRunId: "run_1234abcd",
    lastTriggeredAt: "2026-07-12T12:01:00.000Z",
    createdAt: "2026-07-12T12:00:00.000Z",
    updatedAt: "2026-07-12T12:01:00.000Z",
  };
  return { dataRoot, projectRoot, projectId, entries, host, schedule };
}

const evaluator: CompletionEvaluator = {
  evaluate: vi.fn(async () => ({ complete: true, needsUser: false, reason: "accepted", failedCriteria: [], feedback: null })),
};

function worktrees(projectRoot: string) {
  return {
    inspectRepository: vi.fn(async () => ({ repositoryRoot: projectRoot, commonGitDirectory: join(projectRoot, ".git"), baseCommit: "a".repeat(40) })),
    requireCleanRepository: vi.fn(async () => undefined),
    create: vi.fn(async (runId: string, repository: { repositoryRoot: string; baseCommit: string }, managedRoot: string) => ({
      runId,
      repositoryRoot: repository.repositoryRoot,
      branch: `pi-loops/${runId}`,
      path: join(managedRoot, runId),
      baseCommit: repository.baseCommit,
    })),
    resume: vi.fn(async (worktree: ManagedWorktree) => worktree),
    commitReview: vi.fn(async (managed: { branch: string }) => ({ branch: managed.branch, commit: "b".repeat(40), worktreeRemoved: false })),
    removeClean: vi.fn(async () => undefined),
  };
}

function workers() {
  const worker = {
    identity: {
      pid: 2_147_483_647,
      ownershipToken: "ownership-token",
      piVersion: "0.80.6",
      sessionId: "session-id",
      sessionFile: "/tmp/session.jsonl",
    },
    runCycle: vi.fn(async (_message: string, _signal?: AbortSignal) => ({ lastAssistantText: "implemented", events: [] })),
    stop: vi.fn(async () => ({ code: 0, signal: null })),
  };
  return { manager: { launch: vi.fn(async (_spec: WorkerLaunchSpec, _ui: ParentWorkerUi) => worker) }, worker };
}

describe("unattended run controller", () => {
  it("creates, evaluates, and finalizes a scheduled review branch", async () => {
    const { dataRoot, projectRoot, projectId, entries, host, schedule } = await harness();
    const git = worktrees(projectRoot);
    const rpc = workers();
    const controller = new UnattendedRunController({ dataRoot, repositoryLockRoot: join(dataRoot, "repository-locks"), worktrees: git, workers: rpc.manager });

    await expect(controller.runSchedule(schedule, "run_1234abcd", evaluator, host, new AbortController().signal))
      .resolves.toEqual({ status: "finished" });

    expect(git.create).toHaveBeenCalledOnce();
    expect(git.commitReview).toHaveBeenCalledOnce();
    expect(git.removeClean).toHaveBeenCalledOnce();
    expect(rpc.worker.stop).toHaveBeenCalledOnce();
    expect(entries.at(-1)).toEqual(expect.objectContaining({ state: "completed" }));
    const stored = await new RunStore(dataRoot, projectId).load("run_1234abcd");
    expect(stored).toEqual(expect.objectContaining({
      state: "completed",
      worker: expect.objectContaining({ branch: "pi-loops/run_1234abcd", reviewCommit: "b".repeat(40), worktreeRetained: false }),
    }));
  });

  it("preserves non-Git scheduled runs for user action without launching a worker", async () => {
    const { dataRoot, projectRoot, entries, host, schedule } = await harness();
    await rm(join(projectRoot, ".git"), { recursive: true, force: true });
    const git = worktrees(projectRoot);
    git.inspectRepository.mockRejectedValue(new NonGitRepositoryError());
    const rpc = workers();
    const controller = new UnattendedRunController({ dataRoot, repositoryLockRoot: join(dataRoot, "repository-locks"), worktrees: git, workers: rpc.manager });

    await expect(controller.runSchedule(schedule, "run_1234abcd", evaluator, host, new AbortController().signal))
      .resolves.toEqual({ status: "interrupted" });
    expect(rpc.manager.launch).not.toHaveBeenCalled();
    expect(entries.at(-1)).toEqual(expect.objectContaining({ state: "awaiting_user" }));

    const initialized = spawnSync("git", ["init", "-q"], { cwd: projectRoot, encoding: "utf8", shell: false });
    if (initialized.status !== 0) throw new Error(initialized.stderr);
    git.inspectRepository.mockResolvedValue({ repositoryRoot: projectRoot, commonGitDirectory: join(projectRoot, ".git"), baseCommit: "a".repeat(40) });
    await expect(controller.runSchedule(schedule, "run_1234abcd", evaluator, host, new AbortController().signal, "restart"))
      .resolves.toEqual({ status: "finished" });
    expect(git.resume).not.toHaveBeenCalled();
    expect(git.create).toHaveBeenCalledOnce();
  });

  it("pauses dirty repositories for user action without launching a worker", async () => {
    const { dataRoot, projectRoot, entries, host, schedule } = await harness();
    const git = worktrees(projectRoot);
    git.requireCleanRepository.mockRejectedValue(new DirtyRepositoryError());
    const rpc = workers();
    const controller = new UnattendedRunController({ dataRoot, repositoryLockRoot: join(dataRoot, "repository-locks"), worktrees: git, workers: rpc.manager });

    await expect(controller.runSchedule(schedule, "run_1234abcd", evaluator, host, new AbortController().signal))
      .resolves.toEqual({ status: "interrupted" });
    expect(rpc.manager.launch).not.toHaveBeenCalled();
    expect(entries.at(-1)).toEqual(expect.objectContaining({ state: "awaiting_user" }));
  });

  it("persists the review commit and retains the worktree when removal needs user action", async () => {
    const { dataRoot, projectRoot, projectId, entries, host, schedule } = await harness();
    const git = worktrees(projectRoot);
    git.removeClean.mockRejectedValue(new WorktreeNeedsUserError("worktree changed after commit"));
    const rpc = workers();
    const controller = new UnattendedRunController({ dataRoot, repositoryLockRoot: join(dataRoot, "repository-locks"), worktrees: git, workers: rpc.manager });

    await expect(controller.runSchedule(schedule, "run_1234abcd", evaluator, host, new AbortController().signal))
      .resolves.toEqual({ status: "interrupted" });

    expect(rpc.worker.stop).toHaveBeenCalledOnce();
    expect(entries.at(-1)).toEqual(expect.objectContaining({ state: "awaiting_user" }));
    expect(await new RunStore(dataRoot, projectId).load("run_1234abcd")).toEqual(expect.objectContaining({
      state: "awaiting_user",
      worker: expect.objectContaining({ reviewCommit: "b".repeat(40), worktreeRetained: true }),
    }));
  });

  it("marks launch failures recoverable, retains the worktree, and releases the writer lease", async () => {
    const { dataRoot, projectRoot, projectId, entries, host, schedule } = await harness();
    const git = worktrees(projectRoot);
    const rpc = workers();
    rpc.manager.launch.mockRejectedValue(new Error("worker launch failed"));
    const controller = new UnattendedRunController({ dataRoot, repositoryLockRoot: join(dataRoot, "repository-locks"), worktrees: git, workers: rpc.manager });

    await expect(controller.runSchedule(schedule, "run_1234abcd", evaluator, host, new AbortController().signal))
      .rejects.toThrow("worker launch failed");

    expect(entries.at(-1)).toEqual(expect.objectContaining({ state: "failed", failureRecoverable: true }));
    expect(await new RunStore(dataRoot, projectId).load("run_1234abcd")).toEqual(expect.objectContaining({
      state: "failed",
      failureRecoverable: true,
      worker: expect.objectContaining({ worktreeRetained: true }),
    }));
    const lease = await acquireWriterLease(writerLeasePath(dataRoot, projectId), 30_000);
    await releaseWriterLease(lease);
  });

  it("stops an in-flight worker without persisting through a compromised repository guard", async () => {
    const { dataRoot, projectRoot, projectId, entries, host, schedule } = await harness();
    const git = worktrees(projectRoot);
    const rpc = workers();
    rpc.worker.runCycle.mockImplementation((_message: string, signal?: AbortSignal) => new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const controller = new UnattendedRunController({
      dataRoot,
      repositoryLockRoot: join(dataRoot, "repository-locks"),
      worktrees: git,
      workers: rpc.manager,
      writerLeaseStaleMs: 2_000,
    });
    const running = controller.runSchedule(schedule, "run_1234abcd", evaluator, host, new AbortController().signal);
    await vi.waitFor(() => expect(controller.activeRunId).toBe("run_1234abcd"));
    const identity = await resolveRepositoryLockIdentity(projectRoot);
    if (identity.kind !== "git") throw new Error("Expected Git identity");
    await rm(`${repositoryWriterLeasePath(join(dataRoot, "repository-locks"), identity.commonGitDirectory)}.lock`, { recursive: true, force: true });

    await expect(running).rejects.toBeInstanceOf(Error);
    expect(rpc.worker.stop).toHaveBeenCalled();
    expect(controller.activeRunId).toBeUndefined();
    expect(entries.some((entry) => entry.state === "failed")).toBe(false);
    expect((await new RunStore(dataRoot, projectId).load("run_1234abcd"))?.state).toBe("running");
    const lock = await acquireControllerWriterLock(dataRoot, { projectRoot, projectId }, 30_000, new Date(), join(dataRoot, "repository-locks"));
    await releaseControllerWriterLock(lock);
  }, 5_000);

  it("restarts with the same run, worktree, session, deadline, and budget epoch", async () => {
    const { dataRoot, projectRoot, projectId, host, schedule } = await harness();
    const git = worktrees(projectRoot);
    const rpc = workers();
    const controller = new UnattendedRunController({
      dataRoot,
      repositoryLockRoot: join(dataRoot, "repository-locks"),
      worktrees: git,
      workers: rpc.manager,
    });
    const needsUser: CompletionEvaluator = {
      evaluate: vi.fn(async () => ({
        complete: false,
        needsUser: true,
        reason: "need guidance",
        failedCriteria: ["guidance"],
        feedback: null,
      })),
    };
    await expect(controller.runSchedule(schedule, "run_1234abcd", needsUser, host, new AbortController().signal, "start"))
      .resolves.toEqual({ status: "interrupted" });
    const interrupted = await new RunStore(dataRoot, projectId).load("run_1234abcd");
    expect(interrupted).toEqual(expect.objectContaining({ state: "awaiting_user", cycle: 1, budgetEpoch: 1 }));
    const deadline = interrupted?.budgetDeadlineAt;

    await expect(controller.runSchedule(schedule, "run_1234abcd", evaluator, host, new AbortController().signal, "restart"))
      .resolves.toEqual({ status: "finished" });

    expect(git.create).toHaveBeenCalledOnce();
    expect(git.resume).toHaveBeenCalledOnce();
    expect(rpc.manager.launch).toHaveBeenCalledTimes(2);
    expect(rpc.manager.launch.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      runId: "run_1234abcd",
      resume: { sessionId: "session-id", sessionFile: "/tmp/session.jsonl" },
    }));
    expect(await new RunStore(dataRoot, projectId).load("run_1234abcd")).toEqual(expect.objectContaining({
      state: "completed",
      runId: "run_1234abcd",
      budgetEpoch: 1,
      budgetDeadlineAt: deadline,
      totalCycles: 2,
    }));
  });

  it("stalls after equivalent failures and resumes with a new finite budget epoch", async () => {
    const { dataRoot, projectRoot, projectId, host, schedule } = await harness();
    const git = worktrees(projectRoot);
    const rpc = workers();
    const controller = new UnattendedRunController({ dataRoot, repositoryLockRoot: join(dataRoot, "repository-locks"), worktrees: git, workers: rpc.manager });
    const incomplete: CompletionEvaluator = {
      evaluate: vi.fn(async () => ({
        complete: false,
        needsUser: false,
        reason: "same failure",
        failedCriteria: ["review"],
        feedback: "try again",
      })),
    };

    await expect(controller.runSchedule(schedule, "run_1234abcd", incomplete, host, new AbortController().signal, "start"))
      .resolves.toEqual({ status: "interrupted" });
    const stalled = await new RunStore(dataRoot, projectId).load("run_1234abcd");
    expect(stalled).toEqual(expect.objectContaining({ state: "stalled", cycle: 2, budgetEpoch: 1, equivalentFailures: 2 }));

    await expect(controller.runSchedule(schedule, "run_1234abcd", evaluator, host, new AbortController().signal, "restart"))
      .resolves.toEqual({ status: "finished" });
    const completed = await new RunStore(dataRoot, projectId).load("run_1234abcd");
    expect(completed).toEqual(expect.objectContaining({ state: "completed", budgetEpoch: 2, cycle: 1, totalCycles: 3 }));
    expect(completed?.budgetHistory).toEqual([
      expect.objectContaining({ epoch: 1, cycles: 2, reason: "same failure" }),
    ]);
  });

  it("makes missing deterministic evidence authoritative and enforces the cycle budget", async () => {
    const { dataRoot, projectRoot, projectId, host, schedule } = await harness();
    const git = worktrees(projectRoot);
    const rpc = workers();
    const completionEvaluator: CompletionEvaluator = { evaluate: vi.fn() };
    const controller = new UnattendedRunController({ dataRoot, repositoryLockRoot: join(dataRoot, "repository-locks"), worktrees: git, workers: rpc.manager });
    const boundedSchedule: ScheduleRecord = {
      ...schedule,
      verifierCommands: ["npm test"],
      budget: { ...schedule.budget, maxCycles: 1, stallThreshold: 3 },
    };

    await expect(controller.runSchedule(boundedSchedule, "run_1234abcd", completionEvaluator, host, new AbortController().signal))
      .resolves.toEqual({ status: "interrupted" });
    expect(completionEvaluator.evaluate).not.toHaveBeenCalled();
    expect(await new RunStore(dataRoot, projectId).load("run_1234abcd")).toEqual(expect.objectContaining({
      state: "budget_exhausted",
      cycle: 1,
      latestEvidence: [expect.objectContaining({ command: "npm test", observed: false, passed: false })],
    }));
  });

  it("persists cancellation, stops the worker, and releases active state", async () => {
    const { dataRoot, projectRoot, projectId, host, schedule } = await harness();
    const git = worktrees(projectRoot);
    const rpc = workers();
    rpc.worker.runCycle.mockImplementation((_message: string, signal?: AbortSignal) => new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
    }));
    const controller = new UnattendedRunController({ dataRoot, repositoryLockRoot: join(dataRoot, "repository-locks"), worktrees: git, workers: rpc.manager });
    const abort = new AbortController();
    const running = controller.runSchedule(schedule, "run_1234abcd", evaluator, host, abort.signal);
    await vi.waitFor(() => expect(controller.activeRunId).toBe("run_1234abcd"));
    abort.abort();

    await expect(running).resolves.toEqual({ status: "interrupted" });
    expect(rpc.worker.stop).toHaveBeenCalled();
    expect(controller.activeRunId).toBeUndefined();
    expect(await new RunStore(dataRoot, projectId).load("run_1234abcd")).toEqual(expect.objectContaining({
      state: "interrupted",
      terminalReason: "Scheduled worker was cancelled",
    }));
  });

  it("rejects duplicate starts and schedule identity changes on restart", async () => {
    const { dataRoot, projectRoot, host, schedule } = await harness();
    const git = worktrees(projectRoot);
    const rpc = workers();
    const controller = new UnattendedRunController({ dataRoot, repositoryLockRoot: join(dataRoot, "repository-locks"), worktrees: git, workers: rpc.manager });
    const needsUser: CompletionEvaluator = {
      evaluate: vi.fn(async () => ({ complete: false, needsUser: true, reason: "guidance", failedCriteria: [], feedback: null })),
    };
    await controller.runSchedule(schedule, "run_1234abcd", needsUser, host, new AbortController().signal, "start");

    await expect(controller.runSchedule(schedule, "run_1234abcd", evaluator, host, new AbortController().signal, "start"))
      .rejects.toThrow("already exists");
    await expect(controller.runSchedule({ ...schedule, goal: "different goal" }, "run_1234abcd", evaluator, host, new AbortController().signal, "restart"))
      .rejects.toThrow("not safely resumable");
    expect(git.resume).not.toHaveBeenCalled();
  });

  it("fails closed rather than attaching to a persisted live worker PID", async () => {
    const { dataRoot, projectRoot, projectId, host, schedule } = await harness();
    const git = worktrees(projectRoot);
    const rpc = workers();
    const controller = new UnattendedRunController({ dataRoot, repositoryLockRoot: join(dataRoot, "repository-locks"), worktrees: git, workers: rpc.manager });
    const needsUser: CompletionEvaluator = {
      evaluate: vi.fn(async () => ({ complete: false, needsUser: true, reason: "guidance", failedCriteria: [], feedback: null })),
    };
    await controller.runSchedule(schedule, "run_1234abcd", needsUser, host, new AbortController().signal, "start");
    const lease = await acquireWriterLease(writerLeasePath(dataRoot, projectId), 30_000);
    try {
      const store = new RunStore(dataRoot, projectId, lease);
      const persisted = await store.load("run_1234abcd");
      if (!persisted?.worker) throw new Error("Expected persisted worker metadata");
      await store.save({ ...persisted, worker: { ...persisted.worker, childPid: process.pid } });
    } finally {
      await releaseWriterLease(lease);
    }

    await expect(controller.runSchedule(schedule, "run_1234abcd", evaluator, host, new AbortController().signal, "restart"))
      .rejects.toThrow(`live worker process: ${process.pid}`);
    expect(git.resume).not.toHaveBeenCalled();
  });

  it("fails closed on an unhandled worker interaction", async () => {
    const { dataRoot, projectRoot, entries, host, schedule } = await harness();
    const git = worktrees(projectRoot);
    const rpc = workers();
    rpc.worker.runCycle.mockRejectedValue(new WorkerInteractionRequiredError("No parent UI"));
    const controller = new UnattendedRunController({ dataRoot, repositoryLockRoot: join(dataRoot, "repository-locks"), worktrees: git, workers: rpc.manager });

    await expect(controller.runSchedule(schedule, "run_1234abcd", evaluator, host, new AbortController().signal))
      .resolves.toEqual({ status: "interrupted" });
    expect(entries.at(-1)).toEqual(expect.objectContaining({ state: "awaiting_user" }));
  });
});
