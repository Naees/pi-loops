import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UnattendedRunController, type UnattendedRunHost } from "../../src/controller/unattended-run-controller.js";
import type { CompletionEvaluator } from "../../src/evidence/evaluator.js";
import { createProjectId } from "../../src/shared/ids.js";
import type { RunRecord, ScheduleRecord } from "../../src/shared/types.js";
import { RunStore } from "../../src/storage/run-store.js";
import { DirtyRepositoryError } from "../../src/worker/git-worktree.js";
import { WorkerInteractionRequiredError } from "../../src/worker/rpc-worker-manager.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function harness() {
  const dataRoot = await mkdtemp(join(tmpdir(), "pi-loops-unattended-data-"));
  const projectDirectory = await mkdtemp(join(tmpdir(), "pi-loops-unattended-project-"));
  temporaryDirectories.push(dataRoot, projectDirectory);
  const projectRoot = await realpath(projectDirectory);
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
    commitReview: vi.fn(async (managed: { branch: string }) => ({ branch: managed.branch, commit: "b".repeat(40), worktreeRemoved: false })),
    removeClean: vi.fn(async () => undefined),
  };
}

function workers() {
  const worker = {
    identity: {
      pid: 123,
      ownershipToken: "ownership-token",
      piVersion: "0.80.6",
      sessionId: "session-id",
      sessionFile: "/tmp/session.jsonl",
    },
    runCycle: vi.fn(async () => ({ lastAssistantText: "implemented", events: [] })),
    stop: vi.fn(async () => ({ code: 0, signal: null })),
  };
  return { manager: { launch: vi.fn(async () => worker) }, worker };
}

describe("unattended run controller", () => {
  it("creates, evaluates, and finalizes a scheduled review branch", async () => {
    const { dataRoot, projectRoot, projectId, entries, host, schedule } = await harness();
    const git = worktrees(projectRoot);
    const rpc = workers();
    const controller = new UnattendedRunController({ dataRoot, worktrees: git, workers: rpc.manager });

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

  it("pauses dirty repositories for user action without launching a worker", async () => {
    const { dataRoot, projectRoot, entries, host, schedule } = await harness();
    const git = worktrees(projectRoot);
    git.requireCleanRepository.mockRejectedValue(new DirtyRepositoryError());
    const rpc = workers();
    const controller = new UnattendedRunController({ dataRoot, worktrees: git, workers: rpc.manager });

    await expect(controller.runSchedule(schedule, "run_1234abcd", evaluator, host, new AbortController().signal))
      .resolves.toEqual({ status: "interrupted" });
    expect(rpc.manager.launch).not.toHaveBeenCalled();
    expect(entries.at(-1)).toEqual(expect.objectContaining({ state: "awaiting_user" }));
  });

  it("fails closed on an unhandled worker interaction", async () => {
    const { dataRoot, projectRoot, entries, host, schedule } = await harness();
    const git = worktrees(projectRoot);
    const rpc = workers();
    rpc.worker.runCycle.mockRejectedValue(new WorkerInteractionRequiredError("No parent UI"));
    const controller = new UnattendedRunController({ dataRoot, worktrees: git, workers: rpc.manager });

    await expect(controller.runSchedule(schedule, "run_1234abcd", evaluator, host, new AbortController().signal))
      .resolves.toEqual({ status: "interrupted" });
    expect(entries.at(-1)).toEqual(expect.objectContaining({ state: "awaiting_user" }));
  });
});
