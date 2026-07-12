import { DEFAULT_CONFIG } from "../config/config.js";
import { AsyncSerialQueue } from "../shared/async-queue.js";
import { createCompletionContract } from "../contracts/completion-contract.js";
import { resolveProjectBinding, type ProjectBinding } from "../contracts/project-binding.js";
import { createScheduleId } from "../shared/ids.js";
import type { RunBudget, ScheduleRecord } from "../shared/types.js";
import { acquireWriterLease, assertWriterLease, LeaseUnavailableError, releaseWriterLease, type WriterLease } from "../storage/lease.js";
import { resolvePiLoopsDataRoot } from "../storage/paths.js";
import { RunStore } from "../storage/run-store.js";
import { ScheduleStore, scheduleClaimLeasePath, scheduleExecutionLeasePath, scheduleLeasePath } from "../storage/schedule-store.js";
import { createUniqueRunId, resolveBudget } from "../controller/attended-goal-support.js";
import {
  completeScheduleOccurrence,
  interruptScheduleOccurrence,
  reconcileMissedSchedule,
  triggerSchedule,
} from "./coalescing.js";
import { parseScheduleExpression, type ParsedScheduleExpression } from "./parser.js";

const SCHEDULE_LEASE_STALE_MS = 30_000;
const CLAIM_LEASE_STALE_MS = 30_000;
const CLAIM_RECHECK_MS = 5_000;
const LEASE_RETRY_MS = 1_000;
const MAX_TIMER_MS = 2_147_000_000;

export interface ScheduleCreateRequest {
  readonly expression: string;
  readonly goal: string;
  readonly constraints?: readonly string[];
  readonly verifierCommands?: readonly string[];
  readonly budget?: Partial<RunBudget>;
  readonly parsedExpression?: ParsedScheduleExpression;
}

export interface ScheduleOccurrenceResult {
  readonly status: "finished" | "interrupted";
}

export type ScheduleOccurrenceRunner = (
  schedule: ScheduleRecord,
  runId: string,
  signal: AbortSignal,
) => Promise<ScheduleOccurrenceResult>;

export interface SchedulerHost {
  readonly cwd: string;
  notify(message: string, level: "info" | "warning" | "error"): void;
}

interface OccurrenceClaims {
  readonly execution: WriterLease;
  readonly occurrence: WriterLease;
  readonly signal: AbortSignal;
}

interface ActiveOccurrence {
  readonly abort: AbortController;
  readonly claims: OccurrenceClaims;
  readonly promise: Promise<void>;
}

export class ScheduleController {
  readonly #dataRoot: string;
  readonly #now: () => Date;
  readonly #minimumRecurringMs: number;
  readonly #claimLeaseStaleMs: number;
  readonly #claimRecheckMs: number;
  readonly #beforeOccurrenceLaunch: (() => Promise<void>) | undefined;
  #binding: ProjectBinding | undefined;
  #runner: ScheduleOccurrenceRunner | undefined;
  #host: SchedulerHost | undefined;
  #timer: NodeJS.Timeout | undefined;
  #stopping = false;
  #active = new Map<string, ActiveOccurrence>();
  readonly #queue = new AsyncSerialQueue();

  constructor(options: {
    dataRoot?: string;
    now?: () => Date;
    minimumRecurringMs?: number;
    claimLeaseStaleMs?: number;
    claimRecheckMs?: number;
    beforeOccurrenceLaunch?: () => Promise<void>;
  } = {}) {
    this.#dataRoot = options.dataRoot ?? resolvePiLoopsDataRoot();
    this.#now = options.now ?? (() => new Date());
    this.#minimumRecurringMs = options.minimumRecurringMs ?? DEFAULT_CONFIG.scheduling.minimumRecurringMs;
    this.#claimLeaseStaleMs = options.claimLeaseStaleMs ?? CLAIM_LEASE_STALE_MS;
    this.#claimRecheckMs = options.claimRecheckMs ?? CLAIM_RECHECK_MS;
    this.#beforeOccurrenceLaunch = options.beforeOccurrenceLaunch;
    if (!Number.isSafeInteger(this.#claimLeaseStaleMs) || this.#claimLeaseStaleMs < 2_000) {
      throw new Error("Claim lease stale timeout must be a safe integer of at least 2000ms");
    }
    if (!Number.isSafeInteger(this.#claimRecheckMs) || this.#claimRecheckMs <= 0) {
      throw new Error("Claim recheck interval must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.#minimumRecurringMs) || this.#minimumRecurringMs <= 0) {
      throw new Error("Minimum recurring interval must be a positive safe integer");
    }
  }

  preview(expression: string): ParsedScheduleExpression {
    return parseScheduleExpression(expression, { now: this.#now(), minimumRecurringMs: this.#minimumRecurringMs });
  }

  async start(host: SchedulerHost, runner: ScheduleOccurrenceRunner): Promise<void> {
    await this.#queue.run(async () => {
      if (this.#binding) throw new Error("Schedule controller is already started");
      this.#binding = await resolveProjectBinding(host.cwd);
      this.#runner = runner;
      this.#host = host;
      this.#stopping = false;
      try {
        await this.#retryScheduleLease(async () => this.#reconcileStoredSchedules());
        await this.#armNextTimer();
      } catch (error) {
        this.#binding = undefined;
        this.#runner = undefined;
        this.#host = undefined;
        throw error;
      }
    });
  }

  async create(request: ScheduleCreateRequest, host: Pick<SchedulerHost, "cwd">): Promise<ScheduleRecord> {
    return this.#queue.run(async () => {
      const binding = await resolveProjectBinding(host.cwd);
      const parsed = request.parsedExpression ?? this.preview(request.expression);
      const contract = createCompletionContract(request.goal, request.verifierCommands ?? [], request.constraints ?? []);
      const budget = resolveBudget(request.budget);
      const createdAt = this.#now().toISOString();
      const schedule = await this.#withMutableStore(binding, async (store) => {
        const record: ScheduleRecord = {
          schemaVersion: 1,
          scheduleId: await this.#createUniqueScheduleId(store),
          projectId: binding.projectId,
          projectRoot: binding.projectRoot,
          state: "enabled",
          goal: contract.goal,
          constraints: contract.constraints,
          verifierCommands: contract.verifiers.map((verifier) => verifier.command),
          budget,
          expression: parsed.expression,
          normalizedExpression: parsed.normalizedExpression,
          timing: parsed.timing,
          nextFireAt: parsed.nextFireAt,
          createdAt,
          updatedAt: createdAt,
        };
        await store.save(record);
        return record;
      });
      if (this.#binding?.projectId === binding.projectId) await this.#armNextTimer();
      return schedule;
    });
  }

  async list(cwd: string): Promise<ScheduleRecord[]> {
    const binding = await resolveProjectBinding(cwd);
    return new ScheduleStore(this.#dataRoot, binding.projectId).list();
  }

  async stop(id: string | undefined, cwd: string): Promise<string | undefined> {
    const binding = await resolveProjectBinding(cwd);
    if (this.#binding?.projectId !== binding.projectId) return undefined;
    if (id === undefined) {
      const first = this.#active.entries().next().value as [string, ActiveOccurrence] | undefined;
      if (!first) return undefined;
      first[1].abort.abort();
      await first[1].promise;
      return first[0];
    }
    const direct = this.#active.get(id);
    if (direct) {
      direct.abort.abort();
      await direct.promise;
      return id;
    }
    const schedule = (await this.list(cwd)).find((candidate) => candidate.activeRunId === id);
    if (!schedule) return undefined;
    const occurrence = this.#active.get(schedule.scheduleId);
    if (!occurrence) return undefined;
    occurrence.abort.abort();
    await occurrence.promise;
    return schedule.scheduleId;
  }

  async delete(scheduleId: string, cwd: string): Promise<void> {
    await this.#queue.run(async () => {
      const binding = await resolveProjectBinding(cwd);
      await this.#withMutableStore(binding, async (store) => {
        const schedule = await store.load(scheduleId);
        if (!schedule) throw new Error(`Schedule not found: ${scheduleId}`);
        if (schedule.state === "running" || schedule.state === "pending_coalesced") {
          throw new Error(`Stop the active scheduled run before deleting ${scheduleId}`);
        }
        await store.delete(scheduleId);
      });
      if (this.#binding?.projectId === binding.projectId) await this.#armNextTimer();
    });
  }

  async shutdown(): Promise<void> {
    this.#stopping = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    for (const occurrence of this.#active.values()) occurrence.abort.abort();
    await Promise.allSettled([...this.#active.values()].map((occurrence) => occurrence.promise));
    await this.#queue.run(async () => {
      this.#binding = undefined;
      this.#runner = undefined;
      this.#host = undefined;
      this.#active.clear();
    });
  }

  async #retryScheduleLease(operation: () => Promise<void>, stopWhenStopping = true): Promise<void> {
    for (;;) {
      try {
        await operation();
        return;
      } catch (error) {
        if (!(error instanceof LeaseUnavailableError)) throw error;
        if (stopWhenStopping && this.#stopping) return;
        await new Promise<void>((resolveDelay) => {
          const timer = setTimeout(resolveDelay, LEASE_RETRY_MS);
          timer.unref();
        });
      }
    }
  }

  async #reconcileStoredSchedules(reconcileMissedEnabled = true): Promise<void> {
    const binding = this.#binding;
    if (!binding) return;
    await this.#withMutableStore(binding, async (store) => {
      for (const schedule of await store.list()) {
        if ((schedule.state === "running" || schedule.state === "pending_coalesced") && !this.#active.has(schedule.scheduleId)) {
          let claims: OccurrenceClaims | undefined;
          try {
            claims = await this.#acquireOccurrenceClaims(binding, schedule.scheduleId);
          } catch (error) {
            if (error instanceof LeaseUnavailableError) continue;
            throw error;
          }
          try {
            await store.save(reconcileMissedSchedule(schedule, this.#now()));
          } finally {
            await this.#releaseOccurrenceClaims(claims);
          }
          continue;
        }
        if (schedule.state === "running" || schedule.state === "pending_coalesced" || !reconcileMissedEnabled) continue;
        const reconciled = reconcileMissedSchedule(schedule, this.#now());
        if (reconciled !== schedule) await store.save(reconciled);
      }
    });
  }

  async #processDue(): Promise<void> {
    const binding = this.#binding;
    if (!binding || this.#stopping) return;
    await this.#reconcileStoredSchedules(false);
    const starts: { schedule: ScheduleRecord; runId: string; claims: OccurrenceClaims }[] = [];
    let writerClaimed = this.#active.size > 0;
    await this.#withMutableStore(binding, async (store) => {
      const runStore = new RunStore(this.#dataRoot, binding.projectId);
      for (const schedule of await store.list()) {
        if (schedule.nextFireAt === undefined || Date.parse(schedule.nextFireAt) > this.#now().getTime()) continue;
        const activeOccurrence = this.#active.get(schedule.scheduleId);
        const locallyActive = activeOccurrence !== undefined;
        if ((schedule.state === "running" || schedule.state === "pending_coalesced") && !locallyActive) continue;
        if (activeOccurrence) await this.#assertOccurrenceClaims(activeOccurrence.claims);
        if (schedule.state === "enabled" && writerClaimed) continue;
        const runId = await createUniqueRunId(runStore);
        let claims: OccurrenceClaims | undefined;
        if (schedule.state === "enabled") {
          try {
            claims = await this.#acquireOccurrenceClaims(binding, schedule.scheduleId);
          } catch (error) {
            if (error instanceof LeaseUnavailableError) continue;
            throw error;
          }
        }
        try {
          if (claims) await this.#assertOccurrenceClaims(claims);
          if (this.#stopping) continue;
          const decision = triggerSchedule(schedule, runId, this.#now());
          if (decision.action === "ignored") continue;
          await store.save(decision.schedule);
          if (decision.action === "start") {
            if (!claims) throw new Error(`Schedule ${schedule.scheduleId} started without occurrence claims`);
            if (this.#stopping) {
              await store.save(interruptScheduleOccurrence(decision.schedule, runId, this.#now()));
              continue;
            }
            writerClaimed = true;
            starts.push({ schedule: decision.schedule, runId, claims });
            claims = undefined;
          }
        } finally {
          if (claims) await this.#releaseOccurrenceClaims(claims);
        }
      }
    });
    try {
      if (starts.length > 0 && this.#beforeOccurrenceLaunch) await this.#beforeOccurrenceLaunch();
      while (starts.length > 0) {
        const start = starts[0] as (typeof starts)[number];
        const launched = this.#launchOccurrence(start.schedule, start.runId, start.claims);
        if (!launched) {
          await this.#retryScheduleLease(
            async () => this.#interruptUnlaunchedOccurrence(start.schedule.scheduleId, start.runId, start.claims),
            false,
          );
        }
        starts.shift();
        if (!launched) await this.#releaseOccurrenceClaims(start.claims).catch(() => undefined);
      }
      await this.#armNextTimer();
    } catch (error) {
      for (const start of starts) {
        await this.#retryScheduleLease(
          async () => this.#interruptUnlaunchedOccurrence(start.schedule.scheduleId, start.runId, start.claims),
          false,
        ).catch(() => undefined);
      }
      throw error;
    } finally {
      await Promise.all(starts.map((start) => this.#releaseOccurrenceClaims(start.claims).catch(() => undefined)));
    }
  }

  async #interruptUnlaunchedOccurrence(scheduleId: string, runId: string, claims: OccurrenceClaims): Promise<void> {
    const binding = this.#binding;
    if (!binding) return;
    await this.#assertOccurrenceClaims(claims);
    await this.#withMutableStore(binding, async (store) => {
      await this.#assertOccurrenceClaims(claims);
      const current = await store.load(scheduleId);
      if (!current || current.activeRunId !== runId) return;
      await store.save(interruptScheduleOccurrence(current, runId, this.#now()));
    });
  }

  #launchOccurrence(schedule: ScheduleRecord, runId: string, claims: OccurrenceClaims): boolean {
    const runner = this.#runner;
    if (!runner || this.#stopping || claims.signal.aborted) return false;
    const abort = new AbortController();
    const handleClaimLoss = (): void => abort.abort(claims.signal.reason);
    claims.signal.addEventListener("abort", handleClaimLoss, { once: true });
    const promise = (async () => {
      let claimTransferred = false;
      try {
        let result: ScheduleOccurrenceResult;
        try {
          result = await runner(schedule, runId, abort.signal);
        } catch (error) {
          result = { status: "interrupted" };
          if (!claims.signal.aborted) {
            this.#host?.notify(`${schedule.scheduleId}: scheduled occurrence failed — ${error instanceof Error ? error.message : String(error)}`, "error");
          }
        }
        if (!claims.signal.aborted) {
          claimTransferred = await this.#settleOccurrenceWithRetry(schedule.scheduleId, runId, result, claims);
        }
      } finally {
        claims.signal.removeEventListener("abort", handleClaimLoss);
        if (!claimTransferred) {
          await this.#releaseOccurrenceClaims(claims).catch((error: unknown) => {
            if (!claims.signal.aborted) {
              this.#host?.notify(`${schedule.scheduleId}: occurrence claim release failed — ${error instanceof Error ? error.message : String(error)}`, "error");
            }
          });
        }
      }
    })().finally(() => {
      if (this.#active.get(schedule.scheduleId)?.promise !== promise) return;
      this.#active.delete(schedule.scheduleId);
      if (!this.#stopping) {
        void this.#queue.run(async () => this.#processDue()).catch((error: unknown) => {
          this.#host?.notify(`Pi Loops scheduler failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        });
      }
    });
    this.#active.set(schedule.scheduleId, { abort, claims, promise });
    return true;
  }

  async #settleOccurrenceWithRetry(
    scheduleId: string,
    runId: string,
    result: ScheduleOccurrenceResult,
    claims: OccurrenceClaims,
  ): Promise<boolean> {
    for (;;) {
      try {
        await this.#assertOccurrenceClaims(claims);
        return await this.#queue.run(async () => this.#settleOccurrence(scheduleId, runId, result, claims));
      } catch (error) {
        if (!(error instanceof LeaseUnavailableError)) throw error;
        this.#host?.notify(`${scheduleId}: waiting to persist scheduled occurrence result`, "warning");
        await new Promise<void>((resolveDelay) => {
          const timer = setTimeout(resolveDelay, LEASE_RETRY_MS);
          timer.unref();
        });
      }
    }
  }

  async #settleOccurrence(
    scheduleId: string,
    runId: string,
    result: ScheduleOccurrenceResult,
    claims: OccurrenceClaims,
  ): Promise<boolean> {
    const binding = this.#binding;
    if (!binding) return false;
    await this.#assertOccurrenceClaims(claims);
    let replacement: { schedule: ScheduleRecord; runId: string } | undefined;
    await this.#withMutableStore(binding, async (store) => {
      await this.#assertOccurrenceClaims(claims);
      const current = await store.load(scheduleId);
      if (!current || current.activeRunId !== runId) return;
      if (result.status === "interrupted") {
        await store.save(interruptScheduleOccurrence(current, runId, this.#now()));
        return;
      }
      const replacementRunId = current.state === "pending_coalesced"
        ? await createUniqueRunId(new RunStore(this.#dataRoot, binding.projectId))
        : undefined;
      const completion = completeScheduleOccurrence(current, runId, this.#now(), replacementRunId);
      await store.save(completion.schedule);
      if (completion.action === "start_pending" && replacementRunId) {
        replacement = { schedule: completion.schedule, runId: replacementRunId };
      }
    });
    if (replacement) {
      const pendingReplacement = replacement;
      if (this.#beforeOccurrenceLaunch) {
        try {
          await this.#beforeOccurrenceLaunch();
        } catch (error) {
          await this.#retryScheduleLease(
            async () => this.#interruptUnlaunchedOccurrence(pendingReplacement.schedule.scheduleId, pendingReplacement.runId, claims),
            false,
          );
          throw error;
        }
      }
      const transferred = this.#launchOccurrence(pendingReplacement.schedule, pendingReplacement.runId, claims);
      if (!transferred) {
        await this.#retryScheduleLease(
          async () => this.#interruptUnlaunchedOccurrence(pendingReplacement.schedule.scheduleId, pendingReplacement.runId, claims),
          false,
        );
      }
      try {
        await this.#armNextTimer();
      } catch (error) {
        if (!transferred) throw error;
        this.#host?.notify(`Pi Loops scheduler failed to arm after claim transfer: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
      return transferred;
    }
    await this.#armNextTimer();
    return false;
  }

  async #armNextTimer(): Promise<void> {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    const binding = this.#binding;
    if (!binding || this.#stopping) return;
    const schedules = await new ScheduleStore(this.#dataRoot, binding.projectId).list();
    const hasActiveOccurrence = this.#active.size > 0;
    const nowMs = this.#now().getTime();
    const candidates = schedules
      .filter((schedule) => schedule.state !== "paused" && schedule.nextFireAt !== undefined &&
        !(hasActiveOccurrence && schedule.state === "enabled" && Date.parse(schedule.nextFireAt) <= nowMs))
      .map((schedule) => Date.parse(schedule.nextFireAt as string))
      .filter(Number.isFinite);
    if (schedules.some((schedule) =>
      (schedule.state === "running" || schedule.state === "pending_coalesced") && !this.#active.has(schedule.scheduleId))) {
      candidates.push(nowMs + this.#claimRecheckMs);
    }
    const nextMs = candidates.sort((left, right) => left - right)[0];
    if (nextMs === undefined) return;
    const unboundedDelayMs = nextMs <= nowMs ? this.#claimRecheckMs : nextMs - nowMs;
    const delayMs = Math.min(unboundedDelayMs, MAX_TIMER_MS);
    this.#scheduleTimer(delayMs);
  }

  #scheduleTimer(delayMs: number): void {
    this.#timer = setTimeout(() => void this.#runTimer(), delayMs);
    this.#timer.unref();
  }

  async #runTimer(): Promise<void> {
    try {
      await this.#queue.run(async () => this.#processDue());
    } catch (error) {
      this.#host?.notify(`Pi Loops scheduler failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      if (!this.#stopping) this.#scheduleTimer(LEASE_RETRY_MS);
    }
  }

  async #acquireOccurrenceClaims(binding: ProjectBinding, scheduleId: string): Promise<OccurrenceClaims> {
    const execution = await acquireWriterLease(
      scheduleExecutionLeasePath(this.#dataRoot, binding.projectId),
      this.#claimLeaseStaleMs,
      this.#now(),
    );
    try {
      const occurrence = await acquireWriterLease(
        scheduleClaimLeasePath(this.#dataRoot, binding.projectId, scheduleId),
        this.#claimLeaseStaleMs,
        this.#now(),
      );
      return { execution, occurrence, signal: AbortSignal.any([execution.signal, occurrence.signal]) };
    } catch (error) {
      await releaseWriterLease(execution).catch(() => undefined);
      throw error;
    }
  }

  async #assertOccurrenceClaims(claims: OccurrenceClaims): Promise<void> {
    await assertWriterLease(claims.execution);
    await assertWriterLease(claims.occurrence);
    if (claims.signal.aborted) {
      const reason = claims.signal.reason;
      throw reason instanceof Error ? reason : new Error("Schedule occurrence claims are not active");
    }
  }

  async #releaseOccurrenceClaims(claims: OccurrenceClaims): Promise<void> {
    const failures: unknown[] = [];
    try {
      await releaseWriterLease(claims.occurrence);
    } catch (error) {
      failures.push(error);
    }
    try {
      await releaseWriterLease(claims.execution);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) throw new AggregateError(failures, "Could not release schedule occurrence claims");
  }

  async #withMutableStore<T>(binding: ProjectBinding, operation: (store: ScheduleStore) => Promise<T>): Promise<T> {
    let lease: WriterLease | undefined;
    try {
      lease = await acquireWriterLease(scheduleLeasePath(this.#dataRoot, binding.projectId), SCHEDULE_LEASE_STALE_MS, this.#now());
      return await operation(new ScheduleStore(this.#dataRoot, binding.projectId, lease));
    } finally {
      if (lease) await releaseWriterLease(lease);
    }
  }

  async #createUniqueScheduleId(store: ScheduleStore): Promise<string> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const scheduleId = createScheduleId();
      if ((await store.load(scheduleId)) === undefined) return scheduleId;
    }
    throw new Error("Could not allocate a unique schedule ID");
  }

}
