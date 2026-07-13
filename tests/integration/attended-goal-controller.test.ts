import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttendedGoalController, type GoalLoopHost } from "../../src/controller/attended-goal-controller.js";
import type { CompletionEvaluator, EvaluationDecision, EvaluationInput } from "../../src/evidence/evaluator.js";
import type { RunRecord } from "../../src/shared/types.js";
import { repositoryWriterLeasePath, resolveRepositoryLockIdentity } from "../../src/storage/controller-writer-lock.js";
import { acquireWriterLease, releaseWriterLease } from "../../src/storage/lease.js";
import { RunStore, writerLeasePath } from "../../src/storage/run-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "pi-loops-goal-"));
  const project = await mkdtemp(join(tmpdir(), "pi-loops-project-"));
  temporaryDirectories.push(root, project);
  let time = Date.parse("2026-07-12T00:00:00.000Z");
  const controller = new AttendedGoalController({ dataRoot: root, repositoryLockRoot: join(root, "repository-locks"), now: () => new Date(++time), evaluatorRetryDelaysMs: [0, 0] });
  const messages: { message: string; delivery: string }[] = [];
  const entries: RunRecord[] = [];
  const notifications: string[] = [];
  const host: GoalLoopHost = {
    cwd: project,
    isIdle: true,
    sendWork(message, delivery) {
      messages.push({ message, delivery });
    },
    notify(message) {
      notifications.push(message);
    },
    appendRunEntry(run) {
      entries.push(run);
    },
    abortAgent: vi.fn(),
  };
  return { root, project, controller, host, messages, entries, notifications };
}

class SequenceEvaluator implements CompletionEvaluator {
  readonly evaluate = vi.fn(async (_input: EvaluationInput, _signal?: AbortSignal): Promise<EvaluationDecision> => {
    const next = this.#decisions.shift();
    if (!next) throw new Error("No evaluator decision configured");
    return next;
  });

  readonly #decisions: EvaluationDecision[];

  constructor(decisions: EvaluationDecision[]) {
    this.#decisions = [...decisions];
  }
}

const accepted: EvaluationDecision = {
  complete: true,
  needsUser: false,
  reason: "Goal and evidence are satisfied.",
  failedCriteria: [],
  feedback: null,
};

const rejected: EvaluationDecision = {
  complete: false,
  needsUser: false,
  reason: "The goal is not complete.",
  failedCriteria: ["implementation incomplete"],
  feedback: "Continue implementation.",
};

let verifierCallSequence = 0;

function recordVerifier(controller: AttendedGoalController, passed: boolean): void {
  controller.recordToolResult({
    toolCallId: `call-${++verifierCallSequence}`,
    toolName: "bash",
    input: { command: "npm test" },
    content: [{ type: "text", text: passed ? "all tests passed" : "2 tests failed" }],
    isError: !passed,
  });
}

describe("attended goal controller", () => {
  it("prevents overlapping writers across Pi data roots and repository subdirectories", async () => {
    const { root, controller, host, project } = await harness();
    const initialized = spawnSync("git", ["init", "-q"], { cwd: project, encoding: "utf8", shell: false });
    if (initialized.status !== 0) throw new Error(initialized.stderr);
    const nested = join(project, "nested");
    await mkdir(nested);
    const contender = new AttendedGoalController({
      dataRoot: join(root, "second-pi-data-root"),
      repositoryLockRoot: join(root, "repository-locks"),
    });
    const nestedHost: GoalLoopHost = { ...host, cwd: nested };
    const started = await controller.start({ goal: "first writer" }, host);
    const inspector = new AttendedGoalController({ dataRoot: root, repositoryLockRoot: join(root, "repository-locks") });
    await expect(inspector.reconcile(project)).resolves.toEqual([]);
    expect(await new RunStore(root, started.projectId).load(started.runId)).toEqual(expect.objectContaining({ state: "running" }));

    await expect(contender.start({ goal: "second writer" }, nestedHost)).rejects.toThrow("Writer lease is already held");

    await controller.stop(started.runId, host);
    const replacement = await contender.start({ goal: "second writer" }, nestedHost);
    await contender.stop(replacement.runId, nestedHost);
  });

  it("aborts active work promptly when the repository guard is compromised", async () => {
    const { root, host, project, notifications } = await harness();
    const initialized = spawnSync("git", ["init", "-q"], { cwd: project, encoding: "utf8", shell: false });
    if (initialized.status !== 0) throw new Error(initialized.stderr);
    const controller = new AttendedGoalController({ dataRoot: root, repositoryLockRoot: join(root, "repository-locks"), writerLeaseStaleMs: 2_000 });
    const started = await controller.start({ goal: "guarded writer" }, host);
    const identity = await resolveRepositoryLockIdentity(project);
    if (identity.kind !== "git") throw new Error("Expected Git identity");
    const leasePath = repositoryWriterLeasePath(join(root, "repository-locks"), identity.commonGitDirectory);

    await rm(`${leasePath}.lock`, { recursive: true, force: true });

    await vi.waitFor(() => {
      expect(host.abortAgent).toHaveBeenCalled();
      expect(controller.activeRunId).toBeUndefined();
      expect(notifications.some((message) => message.includes("Repository writer lock was lost"))).toBe(true);
    }, { timeout: 3_000 });
    const replacement = new AttendedGoalController({ dataRoot: root, repositoryLockRoot: join(root, "repository-locks") });
    await expect(replacement.reconcile(project)).resolves.toEqual([
      expect.objectContaining({
        runId: started.runId,
        state: "interrupted",
        transitions: expect.arrayContaining([expect.objectContaining({ reason: "Pi process ended before the run settled" })]),
      }),
    ]);
    const run = await replacement.start({ goal: "replacement writer" }, host);
    await replacement.stop(run.runId, host);
  });

  it("uses explicit verifier commands instead of inferred project scripts", async () => {
    const { host, controller, messages, notifications } = await harness();
    await writeFile(join(host.cwd, "package.json"), JSON.stringify({ scripts: { test: "vitest", build: "tsc" } }));
    const run = await controller.start({
      goal: "fix tests after checking `npm run inferred-check`",
      verifierCommands: ["npm run custom-check"],
      budget: { maxCycles: 2, maxActiveMs: 60_000 },
    }, host);
    expect(messages[0]?.message).toContain("Run exactly: npm run custom-check");
    expect(messages[0]?.message).not.toContain("Run exactly: npm test");
    expect(messages[0]?.message).not.toContain("Run exactly: npm run inferred-check");
    expect(notifications[0]).toContain("npm run custom-check");
    expect(notifications[0]).not.toContain("npm test");
    expect(notifications[0]).not.toContain("Verification: npm run inferred-check");
    await controller.stop(run.runId, host);
  });

  it("infers existing project test scripts when no verifier is explicit", async () => {
    const { controller, host, project, messages } = await harness();
    await writeFile(join(project, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));

    await controller.start({ goal: "implement the feature" }, host);

    expect(messages[0]?.message).toContain("Run exactly: npm test");
    await controller.stop(undefined, host);
  });

  it("completes only after deterministic evidence and fresh evaluation pass", async () => {
    const { controller, host, messages, entries } = await harness();
    const evaluator = new SequenceEvaluator([accepted]);
    const started = await controller.start({ goal: "tests pass", verifierCommands: ["npm test"] }, host);
    recordVerifier(controller, true);

    await controller.settle("Implemented the fix and ran tests.", evaluator, host);

    expect(controller.activeRunId).toBeUndefined();
    expect(evaluator.evaluate).toHaveBeenCalledOnce();
    expect(entries.at(-1)).toEqual(expect.objectContaining({ runId: started.runId, state: "completed" }));
    expect(messages).toHaveLength(1);
    const status = await controller.status(host);
    expect(status).toContain(`${started.runId}  completed`);
    expect(status).toContain("1/1 required verifier(s) passed");
    expect(status).toContain("reason: Goal and evidence are satisfied.");
  });

  it("never consults the model to override failed deterministic evidence", async () => {
    const { controller, host, messages } = await harness();
    const evaluator = new SequenceEvaluator([accepted]);
    await controller.start({ goal: "tests pass", verifierCommands: ["npm test"] }, host);
    recordVerifier(controller, false);

    await controller.settle("Tests still fail.", evaluator, host);

    expect(evaluator.evaluate).not.toHaveBeenCalled();
    expect(controller.activeRunId).toBeDefined();
    expect(messages).toHaveLength(2);
    expect(messages.at(-1)?.message).toContain("Command exits successfully: npm test: 2 tests failed");
  });

  it("bounds oversized worker summaries without stranding the run", async () => {
    const { controller, host, entries } = await harness();
    await controller.start({ goal: "finish" }, host);

    await controller.settle("界".repeat(20_000), new SequenceEvaluator([accepted]), host);

    expect(entries.at(-1)?.state).toBe("completed");
    expect(Buffer.byteLength(entries.at(-1)?.latestWorkerSummary ?? "", "utf8")).toBeLessThanOrEqual(32 * 1024);
  });

  it("retries transient evaluator failures before accepting completion", async () => {
    const { controller, host, entries } = await harness();
    const evaluate = vi.fn()
      .mockRejectedValueOnce(new Error("provider overloaded"))
      .mockRejectedValueOnce(new Error("provider overloaded"))
      .mockResolvedValueOnce(accepted);
    const evaluator: CompletionEvaluator = { evaluate };
    await controller.start({ goal: "finish" }, host);

    await controller.settle("Finished.", evaluator, host);

    expect(evaluate).toHaveBeenCalledTimes(3);
    expect(entries.at(-1)).toEqual(expect.objectContaining({ state: "completed" }));
  });

  it("fails recoverably only after repeated evaluator errors and can resume as the sole candidate", async () => {
    const { root, controller, host, entries } = await harness();
    const evaluate = vi.fn().mockRejectedValue(new Error("provider unavailable"));
    const evaluator: CompletionEvaluator = { evaluate };
    const started = await controller.start({ goal: "finish" }, host);

    await controller.settle("Finished.", evaluator, host);

    expect(evaluate).toHaveBeenCalledTimes(3);
    expect(entries.at(-1)).toEqual(expect.objectContaining({ state: "failed", failureRecoverable: true }));
    const replacement = new AttendedGoalController({ dataRoot: root, repositoryLockRoot: join(root, "repository-locks") });
    const resumed = await replacement.resume({ guidance: "Retry with the provider." }, host);
    expect(resumed).toEqual(expect.objectContaining({ runId: started.runId, state: "running", cycle: 0, budgetEpoch: 2 }));
    expect(resumed.budgetHistory).toEqual([expect.objectContaining({ epoch: 1, reason: "provider unavailable" })]);
    await replacement.stop(started.runId, host);
  });

  it("stops after three equivalent failures and resumes in a fresh epoch", async () => {
    const { root, controller, host, entries } = await harness();
    const evaluator = new SequenceEvaluator([]);
    await controller.start({ goal: "tests pass", verifierCommands: ["npm test"] }, host);

    for (let cycle = 0; cycle < 3; cycle += 1) {
      recordVerifier(controller, false);
      await controller.settle("The same tests fail.", evaluator, host);
    }

    expect(controller.activeRunId).toBeUndefined();
    const stalled = entries.at(-1);
    expect(stalled).toEqual(expect.objectContaining({ state: "stalled", equivalentFailures: 3 }));
    const replacement = new AttendedGoalController({ dataRoot: root, repositoryLockRoot: join(root, "repository-locks") });
    const resumed = await replacement.resume({ runId: stalled!.runId, budget: { maxCycles: 2, maxActiveMs: 60_000 } }, host);
    expect(resumed).toEqual(expect.objectContaining({ state: "running", cycle: 0, equivalentFailures: 0, budgetEpoch: 2 }));
    expect(resumed.budgetHistory).toEqual([expect.objectContaining({ epoch: 1 })]);
    await replacement.stop(resumed.runId, host);
  });

  it("enforces the active wall-time budget even before a cycle settles", async () => {
    const { controller, host, entries } = await harness();
    await controller.start({ goal: "long-running work", budget: { maxActiveMs: 1 } }, host);
    await vi.waitFor(() => {
      expect(host.abortAgent).toHaveBeenCalled();
      expect(controller.activeRunId).toBeUndefined();
    });
    expect(entries.at(-1)).toEqual(expect.objectContaining({ state: "budget_exhausted" }));
  });

  it("stops with budget exhaustion after an incomplete final cycle and resumes in a fresh epoch", async () => {
    const { root, controller, host, entries } = await harness();
    const evaluator = new SequenceEvaluator([rejected]);
    await controller.start({ goal: "finish implementation", budget: { maxCycles: 1 } }, host);

    await controller.settle("Not finished.", evaluator, host);

    expect(controller.activeRunId).toBeUndefined();
    const exhausted = entries.at(-1);
    expect(exhausted).toEqual(expect.objectContaining({ state: "budget_exhausted", cycle: 1 }));
    const replacement = new AttendedGoalController({ dataRoot: root, repositoryLockRoot: join(root, "repository-locks") });
    const resumed = await replacement.resume({ runId: exhausted!.runId, budget: { maxCycles: 3, maxActiveMs: 60_000 } }, host);
    expect(resumed).toEqual(expect.objectContaining({ state: "running", cycle: 0, budgetEpoch: 2 }));
    expect(resumed.budgetHistory).toEqual([expect.objectContaining({ epoch: 1, cycles: 1 })]);
    await replacement.stop(resumed.runId, host);
  });

  it("does not cancel a different active run when the requested ID is wrong", async () => {
    const { controller, host } = await harness();
    const started = await controller.start({ goal: "finish implementation" }, host);

    await expect(controller.stop("run_deadbeef", host)).rejects.toThrow(`Active run is ${started.runId}`);
    expect(controller.activeRunId).toBe(started.runId);
    await controller.stop(started.runId, host);
  });

  it("cancels an active run", async () => {
    const { controller, host, entries } = await harness();
    const started = await controller.start({ goal: "finish implementation" }, host);

    await controller.stop(started.runId, host);

    expect(controller.activeRunId).toBeUndefined();
    expect(host.abortAgent).toHaveBeenCalledOnce();
    expect(entries.at(-1)).toEqual(expect.objectContaining({ state: "cancelled" }));
  });

  it("lets cancellation win over a late successful evaluator response", async () => {
    const { controller, host, entries, messages } = await harness();
    let resolveEvaluation: ((decision: EvaluationDecision) => void) | undefined;
    let evaluationSignal: AbortSignal | undefined;
    const evaluator: CompletionEvaluator = {
      evaluate: vi.fn((_input, signal) => {
        evaluationSignal = signal;
        return new Promise<EvaluationDecision>((resolve) => {
          resolveEvaluation = resolve;
        });
      }),
    };
    const started = await controller.start({ goal: "finish", verifierCommands: ["npm test"] }, host);
    recordVerifier(controller, true);
    const settling = controller.settle("finished", evaluator, host);
    await vi.waitFor(() => expect(evaluator.evaluate).toHaveBeenCalledOnce());

    const stopping = controller.stop(started.runId, host);
    expect(evaluationSignal?.aborted).toBe(true);
    resolveEvaluation?.(accepted);
    await Promise.all([settling, stopping]);

    expect(controller.activeRunId).toBeUndefined();
    expect(entries.at(-1)).toEqual(expect.objectContaining({ state: "cancelled" }));
    expect(entries.some((entry) => entry.state === "completed")).toBe(false);
    expect(messages).toHaveLength(1);
    const replacement = await controller.start({ goal: "replacement" }, host);
    await controller.stop(replacement.runId, host);
  });

  it("discards active state when startup host callbacks fail", async () => {
    const { controller, host } = await harness();
    const appendRunEntry = vi.spyOn(host, "appendRunEntry").mockImplementation(() => {
      throw new Error("transcript unavailable");
    });

    await expect(controller.start({ goal: "finish" }, host)).rejects.toThrow("transcript unavailable");
    expect(controller.activeRunId).toBeUndefined();

    appendRunEntry.mockRestore();
    const restarted = await controller.start({ goal: "start another run" }, host);
    await controller.stop(restarted.runId, host);
  });

  it("releases the writer lease when terminal host callbacks fail", async () => {
    const { controller, host } = await harness();
    await controller.start({ goal: "finish" }, host);
    const appendRunEntry = vi.spyOn(host, "appendRunEntry").mockImplementation(() => {
      throw new Error("transcript unavailable");
    });

    await expect(controller.settle("Finished.", new SequenceEvaluator([accepted]), host)).rejects.toThrow("transcript unavailable");
    expect(controller.activeRunId).toBeUndefined();

    appendRunEntry.mockRestore();
    const restarted = await controller.start({ goal: "start another run" }, host);
    await controller.stop(restarted.runId, host);
  });

  it("releases the writer lease when terminal persistence fails", async () => {
    const { controller, host } = await harness();
    await controller.start({ goal: "finish" }, host);
    const originalSave = RunStore.prototype.save;
    const save = vi.spyOn(RunStore.prototype, "save").mockImplementation(function (this: RunStore, run: RunRecord) {
      if (run.state === "completed") return Promise.reject(new Error("storage unavailable"));
      return originalSave.call(this, run);
    });

    await expect(controller.settle("Finished.", new SequenceEvaluator([accepted]), host)).rejects.toThrow("storage unavailable");
    expect(controller.activeRunId).toBeUndefined();

    save.mockRestore();
    const restarted = await controller.start({ goal: "start another run" }, host);
    await controller.stop(restarted.runId, host);
  });

  it("requires selection among multiple resumable runs and honors selection cancellation", async () => {
    const { root, controller, host } = await harness();
    const first = await controller.start({ goal: "first" }, host);
    await controller.interrupt(host);
    const secondController = new AttendedGoalController({ dataRoot: root, repositoryLockRoot: join(root, "repository-locks") });
    const second = await secondController.start({ goal: "second" }, host);
    await secondController.interrupt(host);

    const replacement = new AttendedGoalController({ dataRoot: root, repositoryLockRoot: join(root, "repository-locks") });
    await expect(replacement.resume({}, host)).rejects.toThrow("Specify a run ID to resume");
    const cancellingHost: GoalLoopHost = { ...host, selectRun: vi.fn(async () => undefined) };
    await expect(replacement.resume({}, cancellingHost)).rejects.toThrow("Specify a run ID to resume");
    const selectingHost: GoalLoopHost = { ...host, selectRun: vi.fn(async () => second.runId) };
    const resumed = await replacement.resume({}, selectingHost);
    expect(resumed.runId).toBe(second.runId);
    expect(resumed.runId).not.toBe(first.runId);
    await replacement.stop(resumed.runId, selectingHost);
  });

  it("rejects legacy resumable records without synthesized completion metadata and releases the lock", async () => {
    const { root, controller, host } = await harness();
    const started = await controller.start({ goal: "legacy work" }, host);
    await controller.interrupt(host);
    const projectId = started.projectId;
    const lease = await acquireWriterLease(writerLeasePath(root, projectId), 30_000);
    try {
      const store = new RunStore(root, projectId, lease);
      const stored = await store.load(started.runId);
      if (!stored) throw new Error("Expected stored run");
      const legacy: Record<string, unknown> = { ...stored };
      delete legacy.constraints;
      delete legacy.verifierCommands;
      delete legacy.budgetEpoch;
      await store.save(legacy as unknown as RunRecord);
    } finally {
      await releaseWriterLease(lease);
    }

    const replacement = new AttendedGoalController({ dataRoot: root, repositoryLockRoot: join(root, "repository-locks") });
    await expect(replacement.resume({ runId: started.runId }, host)).rejects.toThrow("predates resumable goal metadata");
    const next = await replacement.start({ goal: "new work" }, host);
    await replacement.stop(next.runId, host);
  });

  it("resumes an interrupted run with a new budget epoch", async () => {
    const { root, project, controller, host } = await harness();
    const started = await controller.start({ goal: "tests pass", verifierCommands: ["npm test"] }, host);
    await controller.interrupt(host);

    let time = Date.parse("2026-07-12T01:00:00.000Z");
    const resumedController = new AttendedGoalController({ dataRoot: root, repositoryLockRoot: join(root, "repository-locks"), now: () => new Date(++time), evaluatorRetryDelaysMs: [0, 0] });
    const resumedEntries: RunRecord[] = [];
    const resumedHost: GoalLoopHost = {
      ...host,
      cwd: project,
      appendRunEntry(run) {
        resumedEntries.push(run);
      },
    };
    const resumed = await resumedController.resume({ runId: started.runId, guidance: "Continue from the failure." }, resumedHost);

    expect(resumed.runId).toBe(started.runId);
    expect(resumed.budgetEpoch).toBe(2);
    expect(resumed.budgetHistory).toHaveLength(1);
    recordVerifier(resumedController, true);
    await resumedController.settle("Tests now pass.", new SequenceEvaluator([accepted]), resumedHost);
    expect(resumedEntries.at(-1)).toEqual(expect.objectContaining({ state: "completed" }));
  });

  it("cleans only eligible terminal runs and preserves every protected retention class", async () => {
    const { root, controller, host } = await harness();
    const started = await controller.start({ goal: "finish" }, host);
    await controller.settle("Finished.", new SequenceEvaluator([accepted]), host);
    const lease = await acquireWriterLease(writerLeasePath(root, started.projectId), 30_000);
    const protectedIds = ["run_a0000001", "run_a0000002", "run_a0000003", "run_a0000004"];
    try {
      const store = new RunStore(root, started.projectId, lease);
      const base = await store.load(started.runId);
      if (!base) throw new Error("Expected completed run");
      for (let index = 1; index <= 48; index += 1) {
        const updatedAt = `2026-07-13T00:00:${String(index).padStart(2, "0")}.000Z`;
        await store.save({
          ...base,
          runId: `run_${index.toString(16).padStart(8, "0")}`,
          updatedAt,
          transitions: [
            ...base.transitions.slice(0, -1),
            { ...base.transitions.at(-1)!, at: updatedAt },
          ],
        });
      }
      const evaluatingIndex = base.transitions.findIndex((transition) => transition.to === "evaluating");
      if (evaluatingIndex < 0) throw new Error("Expected evaluating transition");
      const withState = (runId: string, state: RunRecord["state"], extra: Partial<RunRecord> = {}): RunRecord => ({
        ...base,
        runId,
        state,
        updatedAt: "2026-07-14T00:00:00.000Z",
        transitions: [
          ...base.transitions.slice(0, evaluatingIndex + 1),
          { from: "evaluating", to: state, at: "2026-07-14T00:00:00.000Z", reason: `fixture ${state}` },
        ],
        ...extra,
      });
      await store.save(withState("run_c0000001", "cancelled"));
      await store.save(withState("run_f0000001", "failed", { failureRecoverable: false, terminalReason: "permanent failure" }));
      await store.save(withState(protectedIds[0]!, "interrupted"));
      await store.save(withState(protectedIds[1]!, "failed", { failureRecoverable: true, terminalReason: "retryable failure" }));
      await store.save(withState(protectedIds[2]!, "running"));
      const retainedId = protectedIds[3]!;
      await store.save(withState(retainedId, "cancelled", {
        mode: "scheduled",
        scheduleId: "schedule_1234abcd",
        worker: {
          repositoryRoot: host.cwd,
          baseCommit: "a".repeat(40),
          branch: `pi-loops/${retainedId}`,
          worktreePath: join(root, "worktrees", retainedId),
          sessionDirectory: join(root, "sessions", retainedId),
          worktreeRetained: true,
        },
      }));
    } finally {
      await releaseWriterLease(lease);
    }

    await expect(controller.clean(host)).resolves.toEqual([started.runId]);
    const store = new RunStore(root, started.projectId);
    for (const runId of protectedIds) expect(await store.load(runId)).toBeDefined();
    await controller.delete("run_00000001", host);
    expect(await store.load("run_00000001")).toBeUndefined();
  });

  it("refuses to delete the active run", async () => {
    const { controller, host } = await harness();
    const started = await controller.start({ goal: "finish" }, host);
    await expect(controller.delete(started.runId, host)).rejects.toThrow("Stop the active run");
    await controller.stop(started.runId, host);
  });

  it("pauses for user input and can resume", async () => {
    const { root, project, controller, host } = await harness();
    const needsUser: EvaluationDecision = {
      complete: false,
      needsUser: true,
      reason: "A product choice is required.",
      failedCriteria: [],
      feedback: "Choose option A or B.",
    };
    const started = await controller.start({ goal: "implement the selected option" }, host);
    await controller.settle("I need a choice.", new SequenceEvaluator([needsUser]), host);
    expect(controller.activeRunId).toBeUndefined();

    let time = Date.parse("2026-07-12T02:00:00.000Z");
    const resumedController = new AttendedGoalController({ dataRoot: root, repositoryLockRoot: join(root, "repository-locks"), now: () => new Date(++time), evaluatorRetryDelaysMs: [0, 0] });
    const resumedHost = { ...host, cwd: project };
    const resumed = await resumedController.resume({ runId: started.runId, guidance: "Use option A." }, resumedHost);
    expect(resumed.state).toBe("running");
    await resumedController.stop(resumed.runId, resumedHost);
  });
});
