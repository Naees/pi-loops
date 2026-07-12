import { DEFAULT_CONFIG } from "../config/config.js";
import { AsyncSerialQueue } from "../shared/async-queue.js";
import { createCompletionContract } from "../contracts/completion-contract.js";
import { resolveProjectBinding, type ProjectBinding } from "../contracts/project-binding.js";
import { createScheduleId } from "../shared/ids.js";
import type { RunBudget, ScheduleRecord } from "../shared/types.js";
import { acquireWriterLease, LeaseUnavailableError, releaseWriterLease, type WriterLease } from "../storage/lease.js";
import { resolvePiLoopsDataRoot } from "../storage/paths.js";
import { RunStore } from "../storage/run-store.js";
import { ScheduleStore, scheduleLeasePath } from "../storage/schedule-store.js";
import { createUniqueRunId, resolveBudget } from "../controller/attended-goal-support.js";
import {
  completeScheduleOccurrence,
  interruptScheduleOccurrence,
  reconcileMissedSchedule,
  triggerSchedule,
} from "./coalescing.js";
import { parseScheduleExpression, type ParsedScheduleExpression } from "./parser.js";

const SCHEDULE_LEASE_STALE_MS = 30_000;
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

interface ActiveOccurrence {
  readonly abort: AbortController;
  readonly promise: Promise<void>;
}

export class ScheduleController {
  readonly #dataRoot: string;
  readonly #now: () => Date;
  readonly #minimumRecurringMs: number;
  #binding: ProjectBinding | undefined;
  #runner: ScheduleOccurrenceRunner | undefined;
  #host: SchedulerHost | undefined;
  #timer: NodeJS.Timeout | undefined;
  #stopping = false;
  #active = new Map<string, ActiveOccurrence>();
  readonly #queue = new AsyncSerialQueue();

  constructor(options: { dataRoot?: string; now?: () => Date; minimumRecurringMs?: number } = {}) {
    this.#dataRoot = options.dataRoot ?? resolvePiLoopsDataRoot();
    this.#now = options.now ?? (() => new Date());
    this.#minimumRecurringMs = options.minimumRecurringMs ?? DEFAULT_CONFIG.scheduling.minimumRecurringMs;
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
        await this.#reconcileStoredSchedules();
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

  async #reconcileStoredSchedules(): Promise<void> {
    const binding = this.#binding;
    if (!binding) return;
    await this.#withMutableStore(binding, async (store) => {
      for (const schedule of await store.list()) {
        const reconciled = reconcileMissedSchedule(schedule, this.#now());
        if (reconciled !== schedule) await store.save(reconciled);
      }
    });
  }

  async #processDue(): Promise<void> {
    const binding = this.#binding;
    if (!binding || this.#stopping) return;
    const starts: { schedule: ScheduleRecord; runId: string }[] = [];
    let writerClaimed = this.#active.size > 0;
    await this.#withMutableStore(binding, async (store) => {
      const runStore = new RunStore(this.#dataRoot, binding.projectId);
      for (const schedule of await store.list()) {
        if (schedule.nextFireAt === undefined || Date.parse(schedule.nextFireAt) > this.#now().getTime()) continue;
        if (schedule.state === "enabled" && writerClaimed) continue;
        const runId = await createUniqueRunId(runStore);
        const decision = triggerSchedule(schedule, runId, this.#now());
        if (decision.action === "ignored") continue;
        await store.save(decision.schedule);
        if (decision.action === "start") {
          writerClaimed = true;
          starts.push({ schedule: decision.schedule, runId });
        }
      }
    });
    await this.#armNextTimer();
    for (const start of starts) this.#launchOccurrence(start.schedule, start.runId);
  }

  #launchOccurrence(schedule: ScheduleRecord, runId: string): void {
    const runner = this.#runner;
    if (!runner || this.#stopping) return;
    const abort = new AbortController();
    const promise = (async () => {
      let result: ScheduleOccurrenceResult;
      try {
        result = await runner(schedule, runId, abort.signal);
      } catch (error) {
        result = { status: "interrupted" };
        this.#host?.notify(`${schedule.scheduleId}: scheduled occurrence failed — ${error instanceof Error ? error.message : String(error)}`, "error");
      }
      await this.#settleOccurrenceWithRetry(schedule.scheduleId, runId, result);
    })().finally(() => {
      if (this.#active.get(schedule.scheduleId)?.promise !== promise) return;
      this.#active.delete(schedule.scheduleId);
      if (!this.#stopping) {
        void this.#queue.run(async () => this.#processDue()).catch((error: unknown) => {
          this.#host?.notify(`Pi Loops scheduler failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        });
      }
    });
    this.#active.set(schedule.scheduleId, { abort, promise });
  }

  async #settleOccurrenceWithRetry(
    scheduleId: string,
    runId: string,
    result: ScheduleOccurrenceResult,
  ): Promise<void> {
    for (;;) {
      try {
        await this.#queue.run(async () => this.#settleOccurrence(scheduleId, runId, result));
        return;
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

  async #settleOccurrence(scheduleId: string, runId: string, result: ScheduleOccurrenceResult): Promise<void> {
    const binding = this.#binding;
    if (!binding) return;
    let replacement: { schedule: ScheduleRecord; runId: string } | undefined;
    await this.#withMutableStore(binding, async (store) => {
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
    await this.#armNextTimer();
    if (replacement) this.#launchOccurrence(replacement.schedule, replacement.runId);
  }

  async #armNextTimer(): Promise<void> {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    const binding = this.#binding;
    if (!binding || this.#stopping) return;
    const schedules = await new ScheduleStore(this.#dataRoot, binding.projectId).list();
    const hasActiveOccurrence = this.#active.size > 0;
    const nextMs = schedules
      .filter((schedule) => schedule.state !== "paused" && schedule.nextFireAt !== undefined &&
        !(hasActiveOccurrence && schedule.state === "enabled" && Date.parse(schedule.nextFireAt) <= this.#now().getTime()))
      .map((schedule) => Date.parse(schedule.nextFireAt as string))
      .filter(Number.isFinite)
      .sort((left, right) => left - right)[0];
    if (nextMs === undefined) return;
    const delayMs = Math.max(0, Math.min(nextMs - this.#now().getTime(), MAX_TIMER_MS));
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
