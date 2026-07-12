import { createCompletionContract, inferBacktickedVerifierCommands, type CompletionContract } from "../contracts/completion-contract.js";
import { resolveProjectBinding } from "../contracts/project-binding.js";
import { inferProjectVerifierCommands } from "../contracts/project-inference.js";
import { CycleEvidenceCollector, requiredEvidencePassed, type ObservedToolResult } from "../evidence/collector.js";
import type { CompletionEvaluator, EvaluationDecision } from "../evidence/evaluator.js";
import { AsyncSerialQueue } from "../shared/async-queue.js";
import { isRunId } from "../shared/ids.js";
import type { RunBudget, RunRecord, RunState } from "../shared/types.js";
import { acquireControllerWriterLock, assertControllerWriterLock, releaseControllerWriterLock, type ControllerWriterLock } from "../storage/controller-writer-lock.js";
import { acquireWriterLease, LeaseUnavailableError, releaseWriterLease, type WriterLease } from "../storage/lease.js";
import { resolvePiLoopsDataRoot } from "../storage/paths.js";
import { RunStore, writerLeasePath } from "../storage/run-store.js";
import { DEFAULT_CONFIG } from "../config/config.js";
import { EMPTY_BUDGET_LEDGER, currentActiveMs, exhaustionReason, incrementCycle, pauseActiveTime, startActiveTime, type BudgetLedger } from "./budgets.js";
import { EMPTY_PROGRESS_TRACKER, createFailureSignature, isStalled, recordFailure, type ProgressTracker } from "./no-progress.js";
import { abortableDelay, buildWorkMessage, boundedRecordText, createUniqueRunId, deterministicFailureDecision, formatContract, formatRunStatus, resolveBudget, retentionEligible } from "./attended-goal-support.js";
import { canTransition, isRecoverableRun, transitionRun } from "./state-machine.js";

const WRITER_LEASE_STALE_MS = 30_000;

export interface GoalStartRequest {
  readonly goal: string;
  readonly constraints?: readonly string[];
  readonly verifierCommands?: readonly string[];
  readonly budget?: Partial<RunBudget>;
}

export interface GoalResumeRequest {
  readonly runId?: string;
  readonly guidance?: string;
  readonly budget?: Partial<RunBudget>;
}

export interface GoalLoopHost {
  readonly cwd: string;
  readonly isIdle: boolean;
  sendWork(message: string, delivery: "immediate" | "followUp"): void;
  notify(message: string, level: "info" | "warning" | "error"): void;
  appendRunEntry(run: RunRecord): void;
  abortAgent(): void;
  selectRun?(runs: readonly RunRecord[]): Promise<string | undefined>;
}

interface ActiveGoal {
  readonly generation: number;
  readonly contract: CompletionContract;
  readonly store: RunStore;
  readonly writerLock: ControllerWriterLock;
  readonly collector: CycleEvidenceCollector;
  readonly evaluatorAbort: AbortController;
  run: RunRecord;
  ledger: BudgetLedger;
  progress: ProgressTracker;
  stopRequested: boolean;
  lockLossHandled: boolean;
  lockAbortHandler: (() => void) | undefined;
  deadlineTimer: NodeJS.Timeout | undefined;
}

export class AttendedGoalController {
  readonly #dataRoot: string;
  readonly #now: () => Date;
  readonly #evaluatorRetryDelaysMs: readonly number[];
  readonly #writerLeaseStaleMs: number;
  #active: ActiveGoal | undefined;
  #generation = 0;
  readonly #queue = new AsyncSerialQueue();

  constructor(options: { dataRoot?: string; now?: () => Date; evaluatorRetryDelaysMs?: readonly number[]; writerLeaseStaleMs?: number } = {}) {
    this.#dataRoot = options.dataRoot ?? resolvePiLoopsDataRoot();
    this.#now = options.now ?? (() => new Date());
    this.#evaluatorRetryDelaysMs = options.evaluatorRetryDelaysMs ?? [250, 1_000];
    this.#writerLeaseStaleMs = options.writerLeaseStaleMs ?? WRITER_LEASE_STALE_MS;
    if (!Number.isSafeInteger(this.#writerLeaseStaleMs) || this.#writerLeaseStaleMs < 2_000) {
      throw new Error("Writer lease stale timeout must be a safe integer of at least 2000ms");
    }
    if (this.#evaluatorRetryDelaysMs.some((delay) => !Number.isSafeInteger(delay) || delay < 0)) {
      throw new Error("Evaluator retry delays must be non-negative safe integers");
    }
  }

  get activeRunId(): string | undefined {
    return this.#active?.run.runId;
  }

  recordToolResult(event: ObservedToolResult): void {
    this.#active?.collector.recordToolResult(event);
  }

  async start(request: GoalStartRequest, host: GoalLoopHost): Promise<RunRecord> {
    return this.#queue.run(async () => {
      if (this.#active) throw new Error(`A goal loop is already active: ${this.#active.run.runId}`);

      const binding = await resolveProjectBinding(host.cwd);
      const { projectRoot, projectId } = binding;
      const writerLock = await acquireControllerWriterLock(this.#dataRoot, binding, this.#writerLeaseStaleMs, this.#now());
      const store = new RunStore(this.#dataRoot, projectId, writerLock.projectLease);

      try {
        await store.reconcileInterrupted(this.#now());
        const budget = resolveBudget(request.budget);
        const backticked = inferBacktickedVerifierCommands(request.goal);
        const inferred = request.verifierCommands ?? (backticked.length > 0 ? backticked : await inferProjectVerifierCommands(projectRoot, request.goal));
        const contract = createCompletionContract(request.goal, inferred, request.constraints ?? []);
        const createdAt = this.#now().toISOString();
        let run: RunRecord = {
          schemaVersion: 1,
          runId: await createUniqueRunId(store),
          projectId,
          mode: "goal",
          state: "configuring",
          goal: contract.goal,
          constraints: contract.constraints,
          verifierCommands: contract.verifiers.map((verifier) => verifier.command),
          budget,
          budgetEpoch: 1,
          budgetHistory: [],
          cycle: 0,
          totalCycles: 0,
          activeMs: 0,
          equivalentFailures: 0,
          latestEvidence: [],
          createdAt,
          updatedAt: createdAt,
          transitions: [],
        };
        await store.save(run);
        run = transitionRun(run, "preflight", "Completion contract is ready", this.#now());
        await store.save(run);
        run = transitionRun(run, "starting", "Attended goal is starting", this.#now());
        await store.save(run);
        run = transitionRun(run, "running", "First attended work cycle started", this.#now());
        await store.save(run);

        await assertControllerWriterLock(writerLock);
        const active = this.#createActiveGoal(contract, store, writerLock, run);
        this.#active = active;
        this.#watchWriterLock(active, host);
        await assertControllerWriterLock(writerLock);
        this.#armDeadline(active, host);
        host.appendRunEntry(run);
        host.notify(formatContract(run, contract), "info");
        host.sendWork(buildWorkMessage(active.run, active.contract, undefined), host.isIdle ? "immediate" : "followUp");
        return run;
      } catch (error) {
        await this.#discardFailedActivation(writerLock);
        throw error;
      }
    });
  }

  async settle(workerSummary: string, evaluator: CompletionEvaluator, host: GoalLoopHost): Promise<void> {
    await this.#queue.run(async () => {
      const active = this.#active;
      if (!active || active.run.state !== "running" || active.stopRequested) return;
      if (!(await this.#ensureWriterLock(active, host))) return;
      const generation = active.generation;

      active.ledger = incrementCycle(active.ledger);
      active.run = {
        ...active.run,
        cycle: active.ledger.cycles,
        totalCycles: (active.run.totalCycles ?? 0) + 1,
        latestWorkerSummary: boundedRecordText(workerSummary, 32 * 1024),
      };
      await this.#move(active, "verifying", "Worker cycle settled");

      const evidence = active.collector.evidenceFor(active.contract);
      active.run = { ...active.run, latestEvidence: evidence };
      await active.store.save(this.#snapshot(active));

      let decision: EvaluationDecision;
      if (!requiredEvidencePassed(evidence)) {
        decision = deterministicFailureDecision(evidence);
      } else {
        await this.#move(active, "evaluating", "Required deterministic evidence passed");
        try {
          decision = await this.#evaluateWithRetries(
            evaluator,
            {
              goal: active.contract.goal,
              constraints: active.contract.constraints,
              workerSummary,
              verifierEvidence: evidence.map((item) => ({
                criterion: item.criterion,
                passed: item.passed,
                summary: item.summary,
              })),
              ...(active.run.latestEvaluation?.feedback ? { previousFeedback: active.run.latestEvaluation.feedback } : {}),
            },
            active.evaluatorAbort.signal,
          );
        } catch (error) {
          if (active.stopRequested || generation !== this.#active?.generation) return;
          await this.#fail(active, error instanceof Error ? error.message : String(error), true, host);
          return;
        }
      }

      if (active.stopRequested || generation !== this.#active?.generation) return;
      active.run = { ...active.run, latestEvaluation: decision };
      await active.store.save(this.#snapshot(active));

      if (decision.complete) {
        if (!requiredEvidencePassed(evidence)) {
          await this.#fail(active, "Evaluator attempted to override required deterministic evidence", false, host);
          return;
        }
        if (active.run.state !== "evaluating") {
          await this.#move(active, "evaluating", "Deterministic decision accepted without model evaluation");
        }
        await this.#move(active, "finalizing", "Completion accepted");
        await this.#finish(active, "completed", decision.reason, host);
        return;
      }

      if (decision.needsUser) {
        await this.#finish(active, "awaiting_user", decision.reason, host);
        return;
      }

      const signature = createFailureSignature(decision.failedCriteria, [decision.reason, ...evidence.map((item) => item.summary)]);
      active.progress = recordFailure(active.progress, signature);
      active.run = {
        ...active.run,
        ...(active.progress.signature === undefined ? {} : { progressSignature: active.progress.signature }),
        equivalentFailures: active.progress.equivalentFailures,
      };

      if (isStalled(active.progress, active.run.budget.stallThreshold)) {
        await this.#finish(active, "stalled", decision.reason, host);
        return;
      }

      const exhausted = exhaustionReason(active.run.budget, active.ledger, this.#now().getTime());
      if (exhausted) {
        await this.#finish(active, "budget_exhausted", `Run exhausted its ${exhausted} budget`, host);
        return;
      }

      if (active.run.state !== "running") {
        await this.#move(active, "running", "Evaluator requested another work cycle");
      }
      active.collector.reset();
      if (!(await this.#ensureWriterLock(active, host))) return;
      host.appendRunEntry(active.run);
      host.notify(`${active.run.runId}: cycle ${active.run.cycle} incomplete — ${decision.reason}`, "warning");
      host.sendWork(buildWorkMessage(active.run, active.contract, decision.feedback ?? decision.reason), "immediate");
    });
  }

  requestStop(): void {
    const active = this.#active;
    if (!active) return;
    active.stopRequested = true;
    active.evaluatorAbort.abort();
  }

  async stop(runId: string | undefined, host: GoalLoopHost): Promise<RunRecord | undefined> {
    const current = this.#active;
    if (current && runId !== undefined && runId !== current.run.runId) {
      throw new Error(`Active run is ${current.run.runId}, not ${runId}`);
    }
    this.requestStop();
    return this.#queue.run(async () => {
      const active = this.#active;
      if (!active) return undefined;
      host.abortAgent();
      await this.#finish(active, "cancelled", "Stopped by the user", host);
      return active.run;
    });
  }

  async interrupt(host: GoalLoopHost): Promise<void> {
    this.requestStop();
    await this.#queue.run(async () => {
      const active = this.#active;
      if (!active) return;
      if (canTransition(active.run.state, "interrupted")) {
        await this.#finish(active, "interrupted", "Pi session shut down", host);
      } else {
        await this.#close(active);
      }
    });
  }

  async resume(request: GoalResumeRequest, host: GoalLoopHost): Promise<RunRecord> {
    return this.#queue.run(async () => {
      if (this.#active) throw new Error(`A goal loop is already active: ${this.#active.run.runId}`);
      if (request.runId !== undefined && !isRunId(request.runId)) throw new Error(`Invalid run ID: ${request.runId}`);

      const binding = await resolveProjectBinding(host.cwd);
      const { projectId } = binding;
      const writerLock = await acquireControllerWriterLock(this.#dataRoot, binding, this.#writerLeaseStaleMs, this.#now());
      const store = new RunStore(this.#dataRoot, projectId, writerLock.projectLease);

      try {
        await store.reconcileInterrupted(this.#now());
        const candidates = (await store.list())
          .filter((run) => run.mode === "goal" && (isRecoverableRun(run) || run.state === "awaiting_user"))
          .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
        let selected = request.runId === undefined ? undefined : candidates.find((run) => run.runId === request.runId);
        if (!selected && request.runId !== undefined) throw new Error(`Run is not resumable: ${request.runId}`);
        if (!selected && candidates.length === 1) selected = candidates[0];
        if (!selected && candidates.length > 1 && host.selectRun) {
          const selectedId = await host.selectRun(candidates);
          selected = candidates.find((run) => run.runId === selectedId);
        }
        if (!selected) throw new Error(candidates.length === 0 ? "No resumable goal runs were found" : "Specify a run ID to resume");
        if (!selected.verifierCommands || !selected.constraints || selected.budgetEpoch === undefined) {
          throw new Error(`Run predates resumable goal metadata: ${selected.runId}`);
        }

        const endedAt = this.#now().toISOString();
        const budget = resolveBudget(request.budget ?? selected.budget);
        const resumeBase: { -readonly [Key in keyof RunRecord]: RunRecord[Key] } = { ...selected };
        delete resumeBase.progressSignature;
        delete resumeBase.terminalReason;
        let run: RunRecord = {
          ...resumeBase,
          budget,
          budgetEpoch: selected.budgetEpoch + 1,
          budgetHistory: [
            ...(selected.budgetHistory ?? []),
            {
              epoch: selected.budgetEpoch,
              budget: selected.budget,
              cycles: selected.cycle,
              activeMs: selected.activeMs ?? 0,
              endedAt,
              reason: selected.terminalReason ?? selected.state,
            },
          ],
          cycle: 0,
          activeMs: 0,
          equivalentFailures: 0,
        };

        if (run.state === "awaiting_user") {
          run = transitionRun(run, "running", "User resumed the run with guidance", this.#now());
        } else {
          run = transitionRun(run, "preflight", "User requested resume", this.#now());
          await store.save(run);
          run = transitionRun(run, "starting", "Resumed attended goal is starting", this.#now());
          await store.save(run);
          run = transitionRun(run, "running", "Resumed attended work cycle started", this.#now());
        }
        await store.save(run);

        const contract = createCompletionContract(run.goal, run.verifierCommands, run.constraints);
        await assertControllerWriterLock(writerLock);
        const active = this.#createActiveGoal(contract, store, writerLock, run);
        this.#active = active;
        this.#watchWriterLock(active, host);
        await assertControllerWriterLock(writerLock);
        this.#armDeadline(active, host);
        host.appendRunEntry(run);
        host.notify(`${run.runId} resumed with budget epoch ${run.budgetEpoch}`, "info");
        host.sendWork(buildWorkMessage(active.run, active.contract, request.guidance ?? run.latestEvaluation?.feedback ?? undefined), host.isIdle ? "immediate" : "followUp");
        return run;
      } catch (error) {
        await this.#discardFailedActivation(writerLock);
        throw error;
      }
    });
  }

  async reconcile(cwd: string): Promise<RunRecord[]> {
    if (this.#active) return [];
    return this.#queue.run(async () => {
      let mutable: { lease: WriterLease; store: RunStore } | undefined;
      try {
        mutable = await this.#openMutableStore(cwd);
        const runIds = await mutable.store.reconcileInterrupted(this.#now());
        const runs = await Promise.all(runIds.map((runId) => mutable?.store.load(runId)));
        return runs.filter((run): run is RunRecord => run !== undefined);
      } catch (error) {
        if (error instanceof LeaseUnavailableError) return [];
        throw error;
      } finally {
        if (mutable) await releaseWriterLease(mutable.lease);
      }
    });
  }

  async clean(host: Pick<GoalLoopHost, "cwd">): Promise<string[]> {
    return this.#queue.run(async () => {
      const { lease, store } = await this.#openMutableStore(host.cwd);
      try {
        return await store.enforceRetention(DEFAULT_CONFIG.retention.terminalRunsPerProject, retentionEligible);
      } finally {
        await releaseWriterLease(lease);
      }
    });
  }

  async delete(runId: string, host: Pick<GoalLoopHost, "cwd">): Promise<void> {
    if (!isRunId(runId)) throw new Error(`Invalid run ID: ${runId}`);
    if (this.#active?.run.runId === runId) throw new Error(`Stop the active run before deleting it: ${runId}`);

    await this.#queue.run(async () => {
      const { lease, store } = await this.#openMutableStore(host.cwd);
      try {
        if ((await store.load(runId)) === undefined) throw new Error(`Run not found: ${runId}`);
        await store.delete(runId);
      } finally {
        await releaseWriterLease(lease);
      }
    });
  }

  async status(host: Pick<GoalLoopHost, "cwd">): Promise<string> {
    if (!this.#active) await this.reconcile(host.cwd);
    const { projectId } = await resolveProjectBinding(host.cwd);
    const store = new RunStore(this.#dataRoot, projectId);
    const runs = (await store.list()).sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    if (runs.length === 0) return "No Pi Loops goal runs are stored for this project.";
    const displayed = runs.slice(0, 10);
    await this.#markAccessed(projectId, displayed.map((run) => run.runId));
    return displayed.map(formatRunStatus).join("\n");
  }

  async #markAccessed(projectId: string, runIds: readonly string[]): Promise<void> {
    if (runIds.length === 0) return;
    if (this.#active?.run.projectId === projectId) {
      for (const runId of runIds) await this.#active.store.markAccessed(runId, this.#now());
      return;
    }

    let lease: WriterLease | undefined;
    try {
      lease = await acquireWriterLease(writerLeasePath(this.#dataRoot, projectId), WRITER_LEASE_STALE_MS, this.#now());
      const store = new RunStore(this.#dataRoot, projectId, lease);
      for (const runId of runIds) await store.markAccessed(runId, this.#now());
    } catch (error) {
      if (!(error instanceof LeaseUnavailableError)) throw error;
    } finally {
      if (lease) await releaseWriterLease(lease);
    }
  }

  async #evaluateWithRetries(
    evaluator: CompletionEvaluator,
    input: Parameters<CompletionEvaluator["evaluate"]>[0],
    signal: AbortSignal,
  ): Promise<EvaluationDecision> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.#evaluatorRetryDelaysMs.length; attempt += 1) {
      try {
        return await evaluator.evaluate(input, signal);
      } catch (error) {
        if (signal.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error;
        lastError = error;
        const delayMs = this.#evaluatorRetryDelaysMs[attempt];
        if (delayMs === undefined) break;
        await abortableDelay(delayMs, signal);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async #openMutableStore(cwd: string): Promise<{ lease: WriterLease; store: RunStore }> {
    const { projectId } = await resolveProjectBinding(cwd);
    const lease = await acquireWriterLease(writerLeasePath(this.#dataRoot, projectId), WRITER_LEASE_STALE_MS, this.#now());
    return { lease, store: new RunStore(this.#dataRoot, projectId, lease) };
  }

  #createActiveGoal(contract: CompletionContract, store: RunStore, writerLock: ControllerWriterLock, run: RunRecord): ActiveGoal {
    return {
      generation: ++this.#generation,
      contract,
      store,
      writerLock,
      collector: new CycleEvidenceCollector(),
      evaluatorAbort: new AbortController(),
      run,
      ledger: startActiveTime(EMPTY_BUDGET_LEDGER, this.#now().getTime()),
      progress: EMPTY_PROGRESS_TRACKER,
      stopRequested: false,
      lockLossHandled: false,
      lockAbortHandler: undefined,
      deadlineTimer: undefined,
    };
  }

  async #discardFailedActivation(writerLock: ControllerWriterLock): Promise<void> {
    const active = this.#active?.writerLock === writerLock ? this.#active : undefined;
    if (active) {
      await this.#close(active).catch(() => undefined);
      return;
    }
    await releaseControllerWriterLock(writerLock).catch(() => undefined);
  }

  async #ensureWriterLock(active: ActiveGoal, host: GoalLoopHost): Promise<boolean> {
    try {
      await assertControllerWriterLock(active.writerLock);
      return true;
    } catch (error) {
      if (this.#beginWriterLockLoss(active, host, error)) await this.#close(active).catch(() => undefined);
      return false;
    }
  }

  #watchWriterLock(active: ActiveGoal, host: GoalLoopHost): void {
    const handleAbort = (): void => {
      if (!this.#beginWriterLockLoss(active, host, active.writerLock.signal.reason)) return;
      void this.#queue.run(async () => this.#close(active)).catch((error: unknown) => {
        host.notify(`Repository writer lock cleanup failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      });
    };
    active.lockAbortHandler = handleAbort;
    active.writerLock.signal.addEventListener("abort", handleAbort, { once: true });
    if (active.writerLock.signal.aborted) handleAbort();
  }

  #beginWriterLockLoss(active: ActiveGoal, host: GoalLoopHost, error: unknown): boolean {
    if (active.lockLossHandled || this.#active?.generation !== active.generation) return false;
    active.lockLossHandled = true;
    active.stopRequested = true;
    active.evaluatorAbort.abort(error);
    host.abortAgent();
    host.notify(`Repository writer lock was lost: ${error instanceof Error ? error.message : String(error)}`, "error");
    return true;
  }

  async #move(active: ActiveGoal, to: RunState, reason: string): Promise<void> {
    active.run = transitionRun(this.#snapshot(active), to, reason, this.#now());
    await active.store.save(active.run);
  }

  async #finish(active: ActiveGoal, state: RunState, reason: string, host: GoalLoopHost): Promise<void> {
    active.ledger = pauseActiveTime(active.ledger, this.#now().getTime());
    const snapshot = this.#snapshot(active);
    active.run = transitionRun(snapshot, state, reason, this.#now());
    active.run = { ...active.run, terminalReason: reason };
    try {
      await active.store.save(active.run);
      host.appendRunEntry(active.run);
      host.notify(`${active.run.runId}: ${state} — ${reason}`, state === "completed" ? "info" : "warning");
      await active.store.enforceRetention(DEFAULT_CONFIG.retention.terminalRunsPerProject, retentionEligible);
    } finally {
      await this.#close(active);
    }
  }

  async #fail(active: ActiveGoal, reason: string, recoverable: boolean, host: GoalLoopHost): Promise<void> {
    active.ledger = pauseActiveTime(active.ledger, this.#now().getTime());
    active.run = transitionRun(this.#snapshot(active), "failed", reason, this.#now(), { failureRecoverable: recoverable });
    try {
      await active.store.save(active.run);
      host.appendRunEntry(active.run);
      host.notify(`${active.run.runId}: failed — ${reason}`, "error");
      await active.store.enforceRetention(DEFAULT_CONFIG.retention.terminalRunsPerProject, retentionEligible);
    } finally {
      await this.#close(active);
    }
  }

  async #close(active: ActiveGoal): Promise<void> {
    if (active.lockAbortHandler) active.writerLock.signal.removeEventListener("abort", active.lockAbortHandler);
    active.lockAbortHandler = undefined;
    if (active.deadlineTimer !== undefined) clearTimeout(active.deadlineTimer);
    active.deadlineTimer = undefined;
    try {
      await releaseControllerWriterLock(active.writerLock);
    } finally {
      if (this.#active?.generation === active.generation) this.#active = undefined;
    }
  }

  #armDeadline(active: ActiveGoal, host: GoalLoopHost): void {
    const schedule = (): void => {
      if (this.#active?.generation !== active.generation) return;
      const remainingMs = active.run.budget.maxActiveMs - currentActiveMs(active.ledger, this.#now().getTime());
      if (remainingMs <= 0) {
        active.stopRequested = true;
        active.evaluatorAbort.abort();
        host.abortAgent();
        void this.#queue.run(async () => {
          if (this.#active?.generation !== active.generation) return;
          await this.#finish(active, "budget_exhausted", "Run exhausted its active_time budget", host);
        }).catch((error: unknown) => {
          host.notify(error instanceof Error ? error.message : String(error), "error");
        });
        return;
      }
      active.deadlineTimer = setTimeout(schedule, Math.min(remainingMs, 2_147_000_000));
      active.deadlineTimer.unref();
    };
    schedule();
  }

  #snapshot(active: ActiveGoal): RunRecord {
    const snapshot: { -readonly [Key in keyof RunRecord]: RunRecord[Key] } = {
      ...active.run,
      cycle: active.ledger.cycles,
      activeMs: currentActiveMs(active.ledger, this.#now().getTime()),
      equivalentFailures: active.progress.equivalentFailures,
    };
    if (active.progress.signature === undefined) delete snapshot.progressSignature;
    else snapshot.progressSignature = active.progress.signature;
    return snapshot;
  }

}

