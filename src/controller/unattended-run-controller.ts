import { join } from "node:path";
import { createCompletionContract } from "../contracts/completion-contract.js";
import { resolveProjectBinding, type ProjectBinding } from "../contracts/project-binding.js";
import { CycleEvidenceCollector, requiredEvidencePassed } from "../evidence/collector.js";
import type { CompletionEvaluator, EvaluationDecision } from "../evidence/evaluator.js";
import { recordRpcToolEvidence } from "../evidence/rpc-collector.js";
import { errorMessage } from "../shared/errors.js";
import { isRunId } from "../shared/ids.js";
import type { RunRecord, RunState, ScheduleRecord, TriggerRecord } from "../shared/types.js";
import { acquireControllerWriterLock, assertControllerWriterLock, releaseControllerWriterLock, resolveGlobalRepositoryLockRoot, type ControllerWriterLock } from "../storage/controller-writer-lock.js";
import { LeaseUnavailableError } from "../storage/lease.js";
import { resolvePiLoopsDataRoot } from "../storage/paths.js";
import { RunStore } from "../storage/run-store.js";
import type { ParentWorkerUi } from "../ui/worker-ui-relay.js";
import {
  GitWorktreeManager,
  NonGitRepositoryError,
  DirtyRepositoryError,
  WorktreeNeedsUserError,
  type FinalizedReviewBranch,
  type ManagedWorktree,
  type RepositoryIdentity,
} from "../worker/git-worktree.js";
import { RpcWorkerManager, WorkerInteractionRequiredError, type WorkerCycleResult, type WorkerLaunchSpec } from "../worker/rpc-worker-manager.js";
import { EMPTY_BUDGET_LEDGER, currentActiveMs, exhaustionReason, incrementCycle, pauseActiveTime, startActiveTime, type BudgetLedger } from "./budgets.js";
import { abortableDelay, boundedRecordText, buildWorkMessage, deterministicFailureDecision } from "./attended-goal-support.js";
import { EMPTY_PROGRESS_TRACKER, createFailureSignature, isStalled, recordFailure, type ProgressTracker } from "./no-progress.js";
import { canTransition, transitionRun } from "./state-machine.js";
import {
  createUnattendedRun,
  isSafeUnattendedRestart,
  prepareUnattendedRestart,
  scheduleDefinition,
  triggerDefinition,
  unattendedLabel,
  type UnattendedDefinition,
} from "./unattended-definition.js";
import type { ScheduleOccurrenceKind, ScheduleOccurrenceResult } from "../scheduler/scheduler.js";

type UnattendedOccurrenceKind = ScheduleOccurrenceKind;

const WRITER_LEASE_STALE_MS = 30_000;
const WRITER_RETRY_MS = 1_000;

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface WorktreeOperations {
  inspectRepository(cwd: string, signal?: AbortSignal): Promise<RepositoryIdentity>;
  requireCleanRepository(repositoryRoot: string, signal?: AbortSignal): Promise<void>;
  create(runId: string, repository: RepositoryIdentity, managedRoot: string, signal?: AbortSignal): Promise<ManagedWorktree>;
  resume(worktree: ManagedWorktree, signal?: AbortSignal): Promise<ManagedWorktree>;
  commitReview(worktree: ManagedWorktree, commitMessage: string, signal?: AbortSignal): Promise<FinalizedReviewBranch>;
  removeClean(worktree: ManagedWorktree, signal?: AbortSignal): Promise<void>;
}

interface WorkerOperations {
  readonly identity: {
    readonly pid: number;
    readonly ownershipToken: string;
    readonly piVersion: string;
    readonly sessionId: string;
    readonly sessionFile: string;
  };
  runCycle(message: string, signal?: AbortSignal): Promise<WorkerCycleResult>;
  stop(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

interface WorkerManagerOperations {
  launch(spec: WorkerLaunchSpec, ui: ParentWorkerUi): Promise<WorkerOperations>;
}

export interface UnattendedRunHost {
  readonly cwd: string;
  readonly ui: ParentWorkerUi;
  notify(message: string, level: "info" | "warning" | "error"): void;
  appendRunEntry(run: RunRecord): void;
}

export class UnattendedRunController {
  readonly #dataRoot: string;
  readonly #now: () => Date;
  readonly #worktrees: WorktreeOperations;
  readonly #workers: WorkerManagerOperations;
  readonly #writerLeaseStaleMs: number;
  readonly #repositoryLockRoot: string;
  #activeWorker: WorkerOperations | undefined;
  #activeRunId: string | undefined;

  constructor(options: {
    dataRoot?: string;
    now?: () => Date;
    worktrees?: WorktreeOperations;
    workers?: WorkerManagerOperations;
    writerLeaseStaleMs?: number;
    repositoryLockRoot?: string;
  } = {}) {
    this.#dataRoot = options.dataRoot ?? resolvePiLoopsDataRoot();
    this.#now = options.now ?? (() => new Date());
    this.#worktrees = options.worktrees ?? new GitWorktreeManager();
    this.#workers = options.workers ?? new RpcWorkerManager();
    this.#writerLeaseStaleMs = options.writerLeaseStaleMs ?? WRITER_LEASE_STALE_MS;
    this.#repositoryLockRoot = options.repositoryLockRoot ?? resolveGlobalRepositoryLockRoot();
    if (!Number.isSafeInteger(this.#writerLeaseStaleMs) || this.#writerLeaseStaleMs < 2_000) {
      throw new Error("Writer lease stale timeout must be a safe integer of at least 2000ms");
    }
  }

  get activeRunId(): string | undefined {
    return this.#activeRunId;
  }

  runSchedule(
    schedule: ScheduleRecord,
    runId: string,
    evaluator: CompletionEvaluator,
    host: UnattendedRunHost,
    signal: AbortSignal,
    kind: ScheduleOccurrenceKind = "start",
  ): Promise<ScheduleOccurrenceResult> {
    return this.#runUnattended(scheduleDefinition(schedule), runId, evaluator, host, signal, kind);
  }

  runTrigger(
    trigger: TriggerRecord,
    runId: string,
    evaluator: CompletionEvaluator,
    host: UnattendedRunHost,
    signal: AbortSignal,
    kind: UnattendedOccurrenceKind = "start",
  ): Promise<ScheduleOccurrenceResult> {
    return this.#runUnattended(triggerDefinition(trigger), runId, evaluator, host, signal, kind);
  }

  async #runUnattended(
    definition: UnattendedDefinition,
    runId: string,
    evaluator: CompletionEvaluator,
    host: UnattendedRunHost,
    signal: AbortSignal,
    kind: UnattendedOccurrenceKind,
  ): Promise<ScheduleOccurrenceResult> {
    if (!isRunId(runId)) throw new Error(`Invalid run ID: ${runId}`);
    const binding = await resolveProjectBinding(host.cwd);
    if (binding.projectId !== definition.projectId || binding.projectRoot !== definition.projectRoot) {
      throw new Error(`${definition.mode === "scheduled" ? "Schedule" : "Trigger"} is bound to a different project`);
    }

    const workKind = definition.mode;
    const workLabel = unattendedLabel(definition);
    let writerLock: ControllerWriterLock | undefined;
    let worker: WorkerOperations | undefined;
    let lockAbortHandler: (() => void) | undefined;
    let run: RunRecord | undefined;
    let ledger: BudgetLedger = EMPTY_BUDGET_LEDGER;
    try {
      writerLock = await this.#waitForWriterLock(binding, signal);
      if (this.#activeRunId) throw new Error(`An unattended run is already active: ${this.#activeRunId}`);
      const executionSignal = AbortSignal.any([signal, writerLock.signal]);
      lockAbortHandler = () => {
        void worker?.stop().catch(() => undefined);
      };
      writerLock.signal.addEventListener("abort", lockAbortHandler, { once: true });
      const store = new RunStore(this.#dataRoot, binding.projectId, writerLock.projectLease);
      run = await this.#prepareRun(store, binding, definition, runId, kind);
      const resuming = kind === "restart";

      let repository;
      try {
        repository = await this.#worktrees.inspectRepository(binding.projectRoot, executionSignal);
        if (writerLock.identity.kind !== "git" || repository.commonGitDirectory !== writerLock.identity.commonGitDirectory) {
          throw new Error(`Locked repository identity does not match ${workKind} worktree identity`);
        }
        await assertControllerWriterLock(writerLock);
        await this.#worktrees.requireCleanRepository(repository.repositoryRoot, executionSignal);
      } catch (error) {
        if (error instanceof NonGitRepositoryError || error instanceof DirtyRepositoryError) {
          run = await this.#pauseForUser(store, run, error.message, host);
          return { status: "interrupted" };
        }
        throw error;
      }

      const reusingWorktree = resuming && run.worker !== undefined;
      if (reusingWorktree && run.worker?.childPid && processExists(run.worker.childPid)) {
        throw new Error(`${workLabel} run still has a live worker process: ${run.worker.childPid}`);
      }
      const managedRoot = join(this.#dataRoot, "projects", binding.projectId, "worktrees");
      await assertControllerWriterLock(writerLock);
      if (reusingWorktree && run.worker?.repositoryRoot !== repository.repositoryRoot) {
        throw new WorktreeNeedsUserError(`Stored managed worktree repository no longer matches the ${workKind} project`);
      }
      const worktree = reusingWorktree
        ? await this.#worktrees.resume({
          runId,
          repositoryRoot: run.worker?.repositoryRoot ?? "",
          baseCommit: run.worker?.baseCommit ?? "",
          branch: run.worker?.branch ?? "",
          path: run.worker?.worktreePath ?? "",
        }, executionSignal)
        : await this.#worktrees.create(runId, repository, managedRoot, executionSignal);
      const sessionDirectory = reusingWorktree
        ? (run.worker as NonNullable<RunRecord["worker"]>).sessionDirectory
        : join(this.#dataRoot, "projects", binding.projectId, "sessions", runId);
      if (!reusingWorktree) {
        run = {
          ...run,
          worker: {
            repositoryRoot: repository.repositoryRoot,
            baseCommit: repository.baseCommit,
            branch: worktree.branch,
            worktreePath: worktree.path,
            sessionDirectory,
            worktreeRetained: true,
          },
        };
        await store.save(run);
      }
      if (!run.budgetDeadlineAt) {
        run = { ...run, budgetDeadlineAt: new Date(this.#now().getTime() + run.budget.maxActiveMs).toISOString() };
        await store.save(run);
      }
      const budgetDeadlineAt = run.budgetDeadlineAt;
      if (!budgetDeadlineAt) throw new Error(`${workLabel} run has no budget deadline`);
      const deadlineMs = Date.parse(budgetDeadlineAt);
      const elapsedByDeadline = Math.max(0, run.budget.maxActiveMs - Math.max(0, deadlineMs - this.#now().getTime()));
      ledger = { cycles: run.cycle, activeMs: Math.max(run.activeMs ?? 0, elapsedByDeadline) };
      const preflightExhaustion = exhaustionReason(run.budget, ledger, this.#now().getTime());
      if (preflightExhaustion) {
        run = await this.#terminal(store, run, "budget_exhausted", `Run exhausted its ${preflightExhaustion} budget`, ledger);
        host.appendRunEntry(run);
        return { status: "interrupted" };
      }
      run = await this.#move(store, run, "starting", `Isolated ${workKind} worker is starting`);

      await assertControllerWriterLock(writerLock);
      worker = await this.#workers.launch({
        runId,
        cwd: worktree.path,
        sessionDirectory,
        absoluteDeadlineMs: deadlineMs,
        ...(reusingWorktree ? {
          resume: {
            sessionId: (run.worker as NonNullable<RunRecord["worker"]>).sessionId as string,
            sessionFile: (run.worker as NonNullable<RunRecord["worker"]>).sessionFile as string,
          },
        } : {}),
      }, host.ui);
      this.#activeWorker = worker;
      this.#activeRunId = runId;
      run = {
        ...run,
        worker: {
          ...(run.worker as NonNullable<RunRecord["worker"]>),
          sessionId: worker.identity.sessionId,
          sessionFile: worker.identity.sessionFile,
          childPid: worker.identity.pid,
          ownershipToken: worker.identity.ownershipToken,
          piVersion: worker.identity.piVersion,
        },
      };
      run = await this.#move(store, run, "running", `Isolated ${workKind} worker started`);
      host.appendRunEntry(run);
      host.notify(`${run.runId}: ${workKind} work ${resuming ? "resumed" : "started"} on ${worktree.branch}`, "info");

      if (!worker) throw new Error(`${workLabel} RPC worker was not initialized`);
      const runningWorker = worker;
      const contract = createCompletionContract(run.goal, run.verifierCommands, run.constraints);
      ledger = startActiveTime(ledger, this.#now().getTime());
      let progress: ProgressTracker = run.progressSignature
        ? { signature: run.progressSignature, equivalentFailures: run.equivalentFailures ?? 0 }
        : EMPTY_PROGRESS_TRACKER;
      let feedback: string | undefined;

      while (!executionSignal.aborted) {
        const collector = new CycleEvidenceCollector();
        await assertControllerWriterLock(writerLock);
        const cycleResult = await runningWorker.runCycle(buildWorkMessage(run as RunRecord, contract, feedback), executionSignal);
        for (const event of cycleResult.events) recordRpcToolEvidence(collector, event);
        ledger = incrementCycle(ledger);
        run = {
          ...(run as RunRecord),
          cycle: ledger.cycles,
          totalCycles: ((run as RunRecord).totalCycles ?? 0) + 1,
          activeMs: currentActiveMs(ledger, this.#now().getTime()),
          latestWorkerSummary: boundedRecordText(cycleResult.lastAssistantText ?? `The ${workKind} worker returned no summary.`, 32 * 1024),
        };
        run = await this.#move(store, run, "verifying", `${workLabel} worker cycle settled`);
        const evidence = collector.evidenceFor(contract);
        const evidencePassed = requiredEvidencePassed(evidence);
        run = { ...run, latestEvidence: evidence };
        await store.save(run);

        let decision: EvaluationDecision;
        if (!evidencePassed) {
          decision = deterministicFailureDecision(evidence);
        } else {
          run = await this.#move(store, run, "evaluating", `${workLabel} deterministic evidence passed`);
          decision = await evaluator.evaluate({
            goal: contract.goal,
            constraints: contract.constraints,
            workerSummary: cycleResult.lastAssistantText ?? "",
            verifierEvidence: evidence.map((item) => ({ criterion: item.criterion, passed: item.passed, summary: item.summary })),
            ...(run.latestEvaluation?.feedback ? { previousFeedback: run.latestEvaluation.feedback } : {}),
          }, executionSignal);
        }
        run = { ...run, latestEvaluation: decision };
        await store.save(run);

        if (decision.complete && evidencePassed) {
          if (run.state !== "evaluating") run = await this.#move(store, run, "evaluating", "Deterministic completion accepted");
          run = await this.#move(store, run, "finalizing", `${workLabel} completion accepted`);
          await runningWorker.stop();
          worker = undefined;
          this.#activeWorker = undefined;
          await assertControllerWriterLock(writerLock);
          const finalized = await this.#worktrees.commitReview(worktree, `Pi Loops ${run.runId}: ${run.goal}`, executionSignal);
          run = {
            ...run,
            worker: {
              ...(run.worker as NonNullable<RunRecord["worker"]>),
              reviewCommit: finalized.commit,
              worktreeRetained: true,
            },
          };
          await store.save(run);
          await assertControllerWriterLock(writerLock);
          await this.#worktrees.removeClean(worktree, executionSignal);
          run = {
            ...run,
            worker: {
              ...(run.worker as NonNullable<RunRecord["worker"]>),
              worktreeRetained: false,
            },
          };
          run = await this.#move(store, run, "completed", `Review branch ready: ${finalized.branch}`);
          run = { ...run, terminalReason: `Review branch ready: ${finalized.branch}` };
          await store.save(run);
          host.appendRunEntry(run);
          host.notify(`${run.runId}: completed — review ${finalized.branch}`, "info");
          return { status: "finished" };
        }
        if (decision.needsUser) {
          run = await this.#terminal(store, run, "awaiting_user", decision.reason, ledger);
          host.appendRunEntry(run);
          return { status: "interrupted" };
        }

        const signature = createFailureSignature(decision.failedCriteria, [decision.reason, ...evidence.map((item) => item.summary)]);
        progress = recordFailure(progress, signature);
        run = {
          ...run,
          ...(progress.signature === undefined ? {} : { progressSignature: progress.signature }),
          equivalentFailures: progress.equivalentFailures,
        };
        if (isStalled(progress, run.budget.stallThreshold)) {
          run = await this.#terminal(store, run, "stalled", decision.reason, ledger);
          host.appendRunEntry(run);
          return { status: "interrupted" };
        }
        const exhausted = exhaustionReason(run.budget, ledger, this.#now().getTime());
        if (exhausted) {
          run = await this.#terminal(store, run, "budget_exhausted", `Run exhausted its ${exhausted} budget`, ledger);
          host.appendRunEntry(run);
          return { status: "interrupted" };
        }
        if (run.state !== "running") run = await this.#move(store, run, "running", `Evaluator requested another ${workKind} cycle`);
        feedback = decision.feedback ?? decision.reason;
      }

      if (run && canTransition(run.state, "interrupted")) {
        run = await this.#terminal(store, run, "interrupted", `${workLabel} worker was cancelled`, ledger);
        host.appendRunEntry(run);
      }
      return { status: "interrupted" };
    } catch (error) {
      if (writerLock?.signal.aborted) {
        const reason = writerLock.signal.reason;
        throw reason instanceof Error ? reason : new Error("Repository writer lock was lost");
      }
      if (run && writerLock) {
        const store = new RunStore(this.#dataRoot, run.projectId, writerLock.projectLease);
        if (signal.aborted && canTransition(run.state, "interrupted")) {
          const paused = ledger.activeSinceMs === undefined ? ledger : pauseActiveTime(ledger, this.#now().getTime());
          const reason = `${workLabel} worker was cancelled`;
          run = transitionRun({ ...run, activeMs: paused.activeMs, cycle: paused.cycles }, "interrupted", reason, this.#now());
          run = { ...run, terminalReason: reason };
          await store.save(run);
          host.appendRunEntry(run);
          return { status: "interrupted" };
        }
        if ((error instanceof WorktreeNeedsUserError || error instanceof WorkerInteractionRequiredError) && canTransition(run.state, "awaiting_user")) {
          run = await this.#pauseForUser(store, run, error.message, host);
          return { status: "interrupted" };
        }
        if (canTransition(run.state, "failed")) {
          run = transitionRun(run, "failed", errorMessage(error), this.#now(), { failureRecoverable: true });
          await store.save(run);
          host.appendRunEntry(run);
        }
      }
      throw error;
    } finally {
      if (writerLock && lockAbortHandler) writerLock.signal.removeEventListener("abort", lockAbortHandler);
      if (worker) await worker.stop().catch(() => undefined);
      this.#activeWorker = undefined;
      this.#activeRunId = undefined;
      if (writerLock) await releaseControllerWriterLock(writerLock).catch(() => undefined);
    }
  }

  async shutdown(): Promise<void> {
    await this.#activeWorker?.stop();
  }

  async #prepareRun(
    store: RunStore,
    binding: ProjectBinding,
    definition: UnattendedDefinition,
    runId: string,
    kind: UnattendedOccurrenceKind,
  ): Promise<RunRecord> {
    const existing = await store.load(runId);
    const label = unattendedLabel(definition);
    if (kind === "start") {
      if (existing) throw new Error(`${label} run already exists: ${runId}`);
      return this.#createRun(store, binding, definition, runId);
    }
    if (!existing) throw new Error(`${label} run does not exist: ${runId}`);
    if (!isSafeUnattendedRestart(existing, definition)) {
      throw new Error(`${label} run is not safely resumable: ${runId}`);
    }

    const resumed = prepareUnattendedRestart(existing, this.#now());
    return this.#move(store, resumed, "preflight", `${label} run restart preflight started`);
  }

  async #createRun(
    store: RunStore,
    binding: ProjectBinding,
    definition: UnattendedDefinition,
    runId: string,
  ): Promise<RunRecord> {
    const created = createUnattendedRun(binding, definition, runId, this.#now().toISOString());
    await store.save(created);
    const label = unattendedLabel(definition);
    return this.#move(store, created, "preflight", `${label} writer preflight started`);
  }

  async #waitForWriterLock(binding: ProjectBinding, signal: AbortSignal): Promise<ControllerWriterLock> {
    while (!signal.aborted) {
      try {
        return await acquireControllerWriterLock(
          this.#dataRoot,
          binding,
          this.#writerLeaseStaleMs,
          this.#now(),
          this.#repositoryLockRoot,
        );
      } catch (error) {
        if (!(error instanceof LeaseUnavailableError)) throw error;
        await abortableDelay(WRITER_RETRY_MS, signal, "Writer wait aborted");
      }
    }
    throw new DOMException("Writer wait aborted", "AbortError");
  }

  async #pauseForUser(store: RunStore, run: RunRecord, reason: string, host: UnattendedRunHost): Promise<RunRecord> {
    const paused = await this.#move(store, run, "awaiting_user", reason);
    host.appendRunEntry(paused);
    host.notify(`${paused.runId}: awaiting_user — ${reason}`, "warning");
    return paused;
  }

  async #move(store: RunStore, run: RunRecord, state: RunState, reason: string): Promise<RunRecord> {
    const moved = transitionRun(run, state, reason, this.#now());
    await store.save(moved);
    return moved;
  }

  async #terminal(store: RunStore, run: RunRecord, state: RunState, reason: string, ledger: BudgetLedger): Promise<RunRecord> {
    const paused = pauseActiveTime(ledger.activeSinceMs === undefined ? startActiveTime(ledger, this.#now().getTime()) : ledger, this.#now().getTime());
    let terminal = transitionRun({ ...run, activeMs: paused.activeMs, cycle: paused.cycles }, state, reason, this.#now());
    terminal = { ...terminal, terminalReason: reason };
    await store.save(terminal);
    return terminal;
  }

}
