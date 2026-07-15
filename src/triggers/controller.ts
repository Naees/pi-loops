import { createCompletionContract } from "../contracts/completion-contract.js";
import { resolveProjectBinding, type ProjectBinding } from "../contracts/project-binding.js";
import { resolveBudget, createUniqueRunId } from "../controller/attended-goal-support.js";
import { isResumableRun } from "../controller/state-machine.js";
import type { ScheduleOccurrenceKind, ScheduleOccurrenceResult } from "../scheduler/scheduler.js";
import { AsyncSerialQueue } from "../shared/async-queue.js";
import { errorMessage } from "../shared/errors.js";
import { allocateUniqueId } from "../shared/id-allocation.js";
import { createTriggerId, isRunId, isTriggerId } from "../shared/ids.js";
import { truncateUtf8 } from "../shared/text.js";
import type { RunBudget, TriggerRecord } from "../shared/types.js";
import { LeaseUnavailableError, type WriterLease } from "../storage/lease.js";
import { withWriterLease } from "../storage/lease-scope.js";
import { resolvePiLoopsDataRoot } from "../storage/paths.js";
import { RunStore } from "../storage/run-store.js";
import { MAX_TRIGGER_DEFINITIONS, TriggerStore, triggerLeasePath } from "../storage/trigger-store.js";
import {
  completeTriggerOccurrence,
  enableTrigger,
  fireTrigger,
  interruptTriggerOccurrence,
  pauseTrigger,
  resumeTriggerOccurrence,
} from "./coalescing.js";
import { TriggerClaimManager } from "./claims.js";
import { TriggerEventIngress } from "./event-ingress.js";
import { FilesystemTriggerManager, resolveFilesystemTarget, type WatchFunction } from "./filesystem.js";

const TRIGGER_LEASE_STALE_MS = 30_000;
const CLAIM_LEASE_STALE_MS = 30_000;
const SETTLEMENT_RETRY_MS = 1_000;
const MAX_TRIGGER_FAILURE_REASON_BYTES = 8 * 1024;

function unrefDelay(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const settle = (completed: boolean): void => {
      signal.removeEventListener("abort", onAbort);
      resolve(completed);
    };
    const timer = setTimeout(() => settle(true), ms);
    timer.unref();
    const onAbort = (): void => {
      clearTimeout(timer);
      settle(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function stoppingError(): Error {
  return new Error("Trigger controller is stopping");
}

class TriggerPausePendingError extends Error {
  constructor(triggerId: string) {
    super(`Trigger occurrence must settle before pausing: ${triggerId}`);
    this.name = "TriggerPausePendingError";
  }
}

export interface TriggerCreateRequest {
  readonly source:
    | { readonly kind: "event" }
    | { readonly kind: "filesystem"; readonly path: string; readonly debounceMs?: number };
  readonly goal: string;
  readonly constraints?: readonly string[];
  readonly verifierCommands?: readonly string[];
  readonly budget?: Partial<RunBudget>;
}

export interface TriggerHost {
  readonly cwd: string;
  notify(message: string, level: "info" | "warning" | "error"): void;
}

interface FilesystemFailureRecord {
  readonly schemaVersion: 1;
  readonly triggerId: string;
  readonly reason: string;
  readonly failedAt: string;
}

interface TriggerStatusRecord {
  readonly trigger: TriggerRecord;
  readonly failure?: FilesystemFailureRecord;
}

export type TriggerOccurrenceKind = ScheduleOccurrenceKind;
export type TriggerOccurrenceRunner = (
  trigger: TriggerRecord,
  runId: string,
  signal: AbortSignal,
  kind: TriggerOccurrenceKind,
  guidance?: string,
) => Promise<ScheduleOccurrenceResult>;

interface ActiveOccurrence {
  readonly runId: string;
  readonly abort: AbortController;
  readonly promise: Promise<void>;
}

function isActiveOccurrence(trigger: Pick<TriggerRecord, "state">): boolean {
  return trigger.state === "running" || trigger.state === "pending_coalesced";
}

export class TriggerController {
  readonly #dataRoot: string;
  readonly #now: () => Date;
  readonly #claims: TriggerClaimManager;
  readonly #settlementRetryMs: number;
  readonly #watchers: FilesystemTriggerManager;
  readonly #queue = new AsyncSerialQueue();
  readonly #active = new Map<string, ActiveOccurrence>();
  readonly #pausing = new Map<string, symbol>();
  readonly #eventIngress: TriggerEventIngress;
  #lifecycle = new AbortController();
  #binding: ProjectBinding | undefined;
  #runner: TriggerOccurrenceRunner | undefined;
  #host: TriggerHost | undefined;
  #stopping = false;

  constructor(options: {
    dataRoot?: string;
    now?: () => Date;
    claimLeaseStaleMs?: number;
    settlementRetryMs?: number;
    watch?: WatchFunction;
  } = {}) {
    this.#dataRoot = options.dataRoot ?? resolvePiLoopsDataRoot();
    this.#now = options.now ?? (() => new Date());
    this.#settlementRetryMs = options.settlementRetryMs ?? SETTLEMENT_RETRY_MS;
    if (!Number.isSafeInteger(this.#settlementRetryMs) || this.#settlementRetryMs <= 0) {
      throw new Error("Settlement retry interval must be a positive safe integer");
    }
    this.#eventIngress = new TriggerEventIngress(this.#now);
    this.#claims = new TriggerClaimManager({
      dataRoot: this.#dataRoot,
      staleMs: options.claimLeaseStaleMs ?? CLAIM_LEASE_STALE_MS,
      now: this.#now,
    });
    this.#watchers = new FilesystemTriggerManager({
      onTrigger: async (triggerId) => {
        const binding = this.#binding;
        if (binding) await this.fire(triggerId, binding.projectRoot);
      },
      onError: (triggerId, error) => this.#handleFilesystemFailure(triggerId, error),
      ...(options.watch === undefined ? {} : { watch: options.watch }),
    });
  }

  async start(host: TriggerHost, runner: TriggerOccurrenceRunner): Promise<void> {
    await this.#queue.run(async () => {
      if (this.#binding) throw new Error("Trigger controller is already started");
      const binding = await resolveProjectBinding(host.cwd);
      this.#lifecycle = new AbortController();
      this.#binding = binding;
      this.#runner = runner;
      this.#host = host;
      this.#stopping = false;
      try {
        await this.#reconcileStoredTriggers();
        for (const trigger of await new TriggerStore(this.#dataRoot, binding.projectId).list()) {
          try {
            await this.#watchers.upsert(trigger);
          } catch (error) {
            const reason = this.#filesystemFailureReason(error);
            host.notify(`${trigger.triggerId}: filesystem watcher could not start — ${reason}`, "warning");
            if (trigger.source.kind === "filesystem" && trigger.state === "enabled") {
              await this.#pauseFilesystemDefinition(binding, trigger.triggerId, this.#failureRecord(trigger.triggerId, reason));
            }
            continue;
          }
          if (trigger.source.kind === "filesystem" && trigger.state === "enabled") {
            await this.#withMutableStore(binding, (store) => store.clearFailure(trigger.triggerId));
          }
        }
      } catch (error) {
        this.#watchers.shutdown();
        this.#lifecycle.abort(error);
        this.#binding = undefined;
        this.#runner = undefined;
        this.#host = undefined;
        throw error;
      }
    });
  }

  async create(request: TriggerCreateRequest, host: Pick<TriggerHost, "cwd">): Promise<TriggerRecord> {
    return this.#queue.run(async () => {
      const binding = await resolveProjectBinding(host.cwd);
      const contract = createCompletionContract(request.goal, request.verifierCommands ?? [], request.constraints ?? []);
      const source = request.source.kind === "event"
        ? { kind: "event" as const }
        : {
          kind: "filesystem" as const,
          relativePath: (await resolveFilesystemTarget(binding.projectRoot, request.source.path)).relativePath,
          debounceMs: request.source.debounceMs ?? 1_000,
        };
      const at = this.#now().toISOString();
      const trigger = await this.#withMutableStore(binding, async (store) => {
        if ((await store.list()).length >= MAX_TRIGGER_DEFINITIONS) {
          throw new Error(`Project already has the maximum of ${MAX_TRIGGER_DEFINITIONS} trigger definitions`);
        }
        const record: TriggerRecord = {
          schemaVersion: 1,
          triggerId: await allocateUniqueId(
            createTriggerId,
            async (triggerId) => (await store.load(triggerId)) === undefined,
            "Could not allocate a unique trigger ID",
          ),
          projectId: binding.projectId,
          projectRoot: binding.projectRoot,
          state: "enabled",
          goal: contract.goal,
          constraints: contract.constraints,
          verifierCommands: contract.verifiers.map((verifier) => verifier.command),
          budget: resolveBudget(request.budget),
          source,
          createdAt: at,
          updatedAt: at,
        };
        await store.save(record);
        return record;
      });
      if (this.#binding?.projectId === binding.projectId) {
        try {
          await this.#watchers.upsert(trigger);
        } catch (error) {
          await this.#withMutableStore(binding, (store) => store.delete(trigger.triggerId)).catch(() => undefined);
          throw error;
        }
      }
      return trigger;
    });
  }

  async list(cwd: string): Promise<TriggerRecord[]> {
    const binding = await resolveProjectBinding(cwd);
    return new TriggerStore(this.#dataRoot, binding.projectId).list();
  }

  async listStatus(cwd: string): Promise<TriggerStatusRecord[]> {
    const binding = await resolveProjectBinding(cwd);
    const store = new TriggerStore(this.#dataRoot, binding.projectId);
    const triggers = await store.list();
    return Promise.all(triggers.map(async (trigger) => {
      const failure = await store.loadFailure(trigger.triggerId);
      return { trigger, ...(failure === undefined ? {} : { failure }) };
    }));
  }

  async fireEvent(triggerId: string, cwd: string, eventId?: string): Promise<"started" | "coalesced" | "ignored"> {
    if (!isTriggerId(triggerId)) throw new Error(`Invalid trigger ID: ${triggerId}`);
    return this.#eventIngress.dispatch(triggerId, eventId, () => this.fire(triggerId, cwd, "event"));
  }

  async fire(triggerId: string, cwd: string, expectedSource?: "event"): Promise<"started" | "coalesced" | "ignored"> {
    if (!isTriggerId(triggerId)) throw new Error(`Invalid trigger ID: ${triggerId}`);
    const lifecycle = this.#lifecycle.signal;
    for (;;) {
      try {
        return await this.#queue.run(async () => {
          const binding = await resolveProjectBinding(cwd);
          if (this.#binding?.projectId !== binding.projectId || !this.#runner || this.#stopping || lifecycle.aborted) {
            throw new Error("Trigger controller is not running for this project");
          }
          const current = await new TriggerStore(this.#dataRoot, binding.projectId).load(triggerId);
          if (!current || (expectedSource === "event" && current.source.kind !== "event")) {
            throw new Error(expectedSource === "event" ? `Event trigger not found: ${triggerId}` : `Trigger not found: ${triggerId}`);
          }
          if (current.state === "paused" || this.#pausing.has(triggerId)) return "ignored";
          const alreadyRunning = isActiveOccurrence(current);
          const lastTriggeredMs = current.lastTriggeredAt ? Date.parse(current.lastTriggeredAt) : Number.NaN;
          const deliveryDeltaMs = this.#now().getTime() - lastTriggeredMs;
          const duplicateFilesystemDelivery = alreadyRunning && !this.#active.has(triggerId) && current.source.kind === "filesystem" &&
            Number.isFinite(lastTriggeredMs) && deliveryDeltaMs >= 0 && deliveryDeltaMs < Math.min(100, current.source.debounceMs);
          if (duplicateFilesystemDelivery) return "ignored";
          if (alreadyRunning && this.#active.has(triggerId)) {
            await this.#coalesce(binding, triggerId);
            return "coalesced";
          }

          let claim: WriterLease;
          try {
            claim = await this.#claims.acquire(binding, triggerId);
          } catch (error) {
            if (!(error instanceof LeaseUnavailableError)) throw error;
            if (!alreadyRunning) return "ignored";
            await this.#coalesce(binding, triggerId);
            return "coalesced";
          }
          let transferred = false;
          try {
            const runId = await createUniqueRunId(new RunStore(this.#dataRoot, binding.projectId));
            let started: TriggerRecord | undefined;
            await this.#withMutableStore(binding, async (store) => {
              await this.#claims.assert(claim);
              let latest = await store.load(triggerId);
              if (!latest) throw new Error(`Trigger not found: ${triggerId}`);
              if (this.#stopping || lifecycle.aborted || this.#pausing.has(triggerId)) return;
              if (isActiveOccurrence(latest) && latest.activeRunId) {
                latest = interruptTriggerOccurrence(latest, latest.activeRunId, this.#now());
              }
              const decision = fireTrigger(latest, runId, this.#now());
              await store.save(decision.trigger);
              if (decision.action === "start") started = decision.trigger;
            });
            if (!started) return "ignored";
            transferred = this.#launch(started, runId, claim, "start");
            return transferred ? "started" : "ignored";
          } finally {
            if (!transferred) await this.#claims.release(claim).catch(() => undefined);
          }
        });
      } catch (error) {
        if (!(error instanceof LeaseUnavailableError)) throw error;
        if (this.#stopping || lifecycle.aborted) throw stoppingError();
        this.#host?.notify(`${triggerId}: waiting for trigger-store access`, "warning");
        if (!(await unrefDelay(this.#settlementRetryMs, lifecycle))) throw stoppingError();
      }
    }
  }

  async stop(id: string | undefined, cwd: string): Promise<string | undefined> {
    const binding = await resolveProjectBinding(cwd);
    if (this.#binding?.projectId !== binding.projectId) return undefined;
    const occurrence = id === undefined
      ? this.#active.entries().next().value as [string, ActiveOccurrence] | undefined
      : this.#active.has(id)
        ? [id, this.#active.get(id) as ActiveOccurrence] as [string, ActiveOccurrence]
        : [...this.#active.entries()].find(([, active]) => active.runId === id);
    const pauseDefinition = id?.startsWith("trigger_") === true;
    const pauseToken = pauseDefinition ? Symbol("trigger pause") : undefined;
    if (pauseDefinition && pauseToken) this.#pausing.set(id, pauseToken);
    try {
      if (occurrence) {
        occurrence[1].abort.abort();
        await occurrence[1].promise;
      }
      if (!pauseDefinition) {
        if (occurrence) {
          await this.#retryTriggerLease(
            () => this.#queue.run(async () => this.#withMutableStore(binding, async (store) => {
              const current = await store.load(occurrence[0]);
              if (current && isActiveOccurrence(current) && current.activeRunId === occurrence[1].runId) {
                await store.save(interruptTriggerOccurrence(current, occurrence[1].runId, this.#now()));
              }
            })),
            this.#lifecycle.signal,
          );
        }
        return occurrence?.[0];
      }
      await this.#retryTriggerLease(
        () => this.#queue.run(async () => {
          await this.#withMutableStore(binding, async (store) => {
            let trigger = await store.load(id);
            if (!trigger) throw new Error(`Trigger not found: ${id}`);
            if (isActiveOccurrence(trigger)) {
              if (!occurrence || trigger.activeRunId !== occurrence[1].runId) {
                throw new Error(`Active trigger must be stopped before pausing: ${id}`);
              }
              trigger = interruptTriggerOccurrence(trigger, occurrence[1].runId, this.#now());
            }
            await store.save(pauseTrigger(trigger, this.#now()));
            await store.clearFailure(id);
          });
          this.#watchers.remove(id);
        }),
        this.#lifecycle.signal,
      );
      return id;
    } finally {
      if (pauseDefinition && pauseToken && this.#pausing.get(id) === pauseToken) this.#pausing.delete(id);
    }
  }

  async enable(triggerId: string, cwd: string): Promise<void> {
    if (!isTriggerId(triggerId)) throw new Error(`Invalid trigger ID: ${triggerId}`);
    await this.#queue.run(async () => {
      const binding = await resolveProjectBinding(cwd);
      if (this.#binding?.projectId !== binding.projectId || this.#stopping) {
        throw new Error("Trigger controller is not running for this project");
      }
      const trigger = await new TriggerStore(this.#dataRoot, binding.projectId).load(triggerId);
      if (!trigger) throw new Error(`Trigger not found: ${triggerId}`);
      const enabled = enableTrigger(trigger, this.#now());
      if (enabled.source.kind === "filesystem") {
        try {
          await this.#watchers.upsert(enabled);
        } catch (error) {
          const reason = this.#filesystemFailureReason(error);
          await this.#withMutableStore(binding, (store) => store.saveFailure(this.#failureRecord(triggerId, reason)));
          throw error;
        }
      }
      try {
        await this.#withMutableStore(binding, async (store) => {
          const current = await store.load(triggerId);
          if (!current) throw new Error(`Trigger not found: ${triggerId}`);
          if (this.#pausing.has(triggerId)) throw new Error(`Filesystem trigger failed while enabling: ${triggerId}`);
          const persisted = enableTrigger(current, this.#now());
          await store.clearFailure(triggerId);
          await store.save(persisted);
        });
      } catch (error) {
        if (enabled.source.kind === "filesystem") this.#watchers.remove(triggerId);
        throw error;
      }
    });
  }

  async resumeOccurrence(triggerId: string, runId: string, cwd: string, guidance?: string): Promise<void> {
    if (!isTriggerId(triggerId)) throw new Error(`Invalid trigger ID: ${triggerId}`);
    if (!isRunId(runId)) throw new Error(`Invalid run ID: ${runId}`);
    await this.#queue.run(async () => {
      const binding = await resolveProjectBinding(cwd);
      if (this.#binding?.projectId !== binding.projectId || !this.#runner || this.#stopping) {
        throw new Error("Trigger controller is not running for this project");
      }
      const run = await new RunStore(this.#dataRoot, binding.projectId).load(runId);
      if (!run || run.mode !== "proactive" || run.triggerId !== triggerId || !isResumableRun(run)) {
        throw new Error(`Proactive run is not resumable: ${runId}`);
      }
      const claim = await this.#claims.acquire(binding, triggerId);
      let transferred = false;
      try {
        let resumed: TriggerRecord | undefined;
        await this.#withMutableStore(binding, async (store) => {
          const trigger = await store.load(triggerId);
          if (!trigger) throw new Error(`Trigger not found: ${triggerId}`);
          resumed = resumeTriggerOccurrence(trigger, runId, this.#now());
          await store.save(resumed);
        });
        if (!resumed) throw new Error(`Trigger could not be resumed: ${triggerId}`);
        transferred = this.#launch(resumed, runId, claim, "restart", guidance);
        if (!transferred) throw new Error(`Trigger could not launch resumed run: ${triggerId}`);
      } finally {
        if (!transferred) await this.#claims.release(claim).catch(() => undefined);
      }
    });
  }

  async delete(triggerId: string, cwd: string): Promise<void> {
    if (!isTriggerId(triggerId)) throw new Error(`Invalid trigger ID: ${triggerId}`);
    await this.#queue.run(async () => {
      const binding = await resolveProjectBinding(cwd);
      await this.#withMutableStore(binding, async (store) => {
        const trigger = await store.load(triggerId);
        if (!trigger) throw new Error(`Trigger not found: ${triggerId}`);
        if (isActiveOccurrence(trigger)) {
          throw new Error(`Stop the active proactive run before deleting ${triggerId}`);
        }
        await store.delete(triggerId);
      });
      this.#eventIngress.forget(triggerId);
      this.#watchers.remove(triggerId);
    });
  }

  async shutdown(): Promise<void> {
    this.#stopping = true;
    this.#lifecycle.abort(stoppingError());
    this.#watchers.shutdown();
    for (const occurrence of this.#active.values()) occurrence.abort.abort();
    await Promise.allSettled([...this.#active.values()].map((occurrence) => occurrence.promise));
    await this.#queue.run(async () => {
      this.#active.clear();
      this.#eventIngress.clear();
      this.#binding = undefined;
      this.#runner = undefined;
      this.#host = undefined;
    });
  }

  #launch(trigger: TriggerRecord, runId: string, claim: WriterLease, kind: TriggerOccurrenceKind, guidance?: string): boolean {
    const runner = this.#runner;
    if (!runner || this.#stopping || claim.signal.aborted) return false;
    const abort = new AbortController();
    const onClaimLoss = (): void => abort.abort(claim.signal.reason);
    claim.signal.addEventListener("abort", onClaimLoss, { once: true });
    const promise = (async () => {
      let transferred = false;
      try {
        let result: ScheduleOccurrenceResult;
        try {
          result = guidance === undefined
            ? await runner(trigger, runId, abort.signal, kind)
            : await runner(trigger, runId, abort.signal, kind, guidance);
        } catch (error) {
          result = { status: "interrupted" };
          if (!claim.signal.aborted) this.#host?.notify(`${trigger.triggerId}: proactive occurrence failed — ${errorMessage(error)}`, "error");
        }
        if (!claim.signal.aborted) transferred = await this.#settleWithRetry(trigger.triggerId, runId, result, claim, abort.signal);
      } finally {
        claim.signal.removeEventListener("abort", onClaimLoss);
        if (!transferred) await this.#claims.release(claim).catch(() => undefined);
      }
    })().catch((error: unknown) => {
      if (!claim.signal.aborted) {
        this.#host?.notify(`${trigger.triggerId}: proactive occurrence settlement failed — ${errorMessage(error)}`, "error");
      }
    }).finally(() => {
      if (this.#active.get(trigger.triggerId)?.promise !== promise) return;
      this.#active.delete(trigger.triggerId);
    });
    this.#active.set(trigger.triggerId, { runId, abort, promise });
    return true;
  }

  async #settleWithRetry(
    triggerId: string,
    runId: string,
    result: ScheduleOccurrenceResult,
    claim: WriterLease,
    signal: AbortSignal,
  ): Promise<boolean> {
    for (;;) {
      try {
        await this.#claims.assert(claim);
        return await this.#settle(triggerId, runId, result, claim);
      } catch (error) {
        if (!(error instanceof LeaseUnavailableError)) throw error;
        if (signal.aborted || claim.signal.aborted || this.#stopping) return false;
        this.#host?.notify(`${triggerId}: waiting to persist proactive occurrence result`, "warning");
        if (!(await unrefDelay(this.#settlementRetryMs, signal))) return false;
      }
    }
  }

  async #retryTriggerLease<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    for (;;) {
      if (signal.aborted || this.#stopping) throw stoppingError();
      try {
        return await operation();
      } catch (error) {
        if (!(error instanceof LeaseUnavailableError) && !(error instanceof TriggerPausePendingError)) throw error;
        if (signal.aborted || this.#stopping) throw stoppingError();
        if (!(await unrefDelay(this.#settlementRetryMs, signal))) throw stoppingError();
      }
    }
  }

  async #settle(
    triggerId: string,
    runId: string,
    result: ScheduleOccurrenceResult,
    claim: WriterLease,
  ): Promise<boolean> {
    return this.#queue.run(async () => {
      const binding = this.#binding;
      if (!binding) return false;
      await this.#claims.assert(claim);
      let replacement: { trigger: TriggerRecord; runId: string } | undefined;
      await this.#withMutableStore(binding, async (store) => {
        await this.#claims.assert(claim);
        const current = await store.load(triggerId);
        if (!current || current.activeRunId !== runId) return;
        if (result.status === "interrupted" || this.#pausing.has(triggerId)) {
          await store.save(interruptTriggerOccurrence(current, runId, this.#now()));
          return;
        }
        const replacementRunId = current.state === "pending_coalesced"
          ? await createUniqueRunId(new RunStore(this.#dataRoot, binding.projectId))
          : undefined;
        const completion = completeTriggerOccurrence(current, runId, this.#now(), replacementRunId);
        await store.save(completion.trigger);
        if (completion.action === "start_pending" && replacementRunId) {
          replacement = { trigger: completion.trigger, runId: replacementRunId };
        }
      });
      if (!replacement) return false;
      return this.#launch(replacement.trigger, replacement.runId, claim, "start");
    });
  }

  async #coalesce(binding: ProjectBinding, triggerId: string): Promise<void> {
    await this.#withMutableStore(binding, async (store) => {
      const latest = await store.load(triggerId);
      if (!latest?.activeRunId) throw new Error(`Active trigger occurrence is missing its run ID: ${triggerId}`);
      await store.save(fireTrigger(latest, latest.activeRunId, this.#now()).trigger);
    });
  }

  async #handleFilesystemFailure(triggerId: string, error: unknown): Promise<void> {
    const binding = this.#binding;
    const host = this.#host;
    const reason = this.#filesystemFailureReason(error);
    const failure = this.#failureRecord(triggerId, reason);
    host?.notify(`${triggerId}: filesystem trigger failed — ${reason}`, "error");
    if (!binding || this.#stopping) return;

    const lifecycle = this.#lifecycle.signal;
    const pauseToken = Symbol("filesystem failure pause");
    this.#pausing.set(triggerId, pauseToken);
    try {
      const occurrence = await this.#queue.run(async () => {
        if (this.#binding?.projectId !== binding.projectId || this.#stopping || lifecycle.aborted ||
          this.#pausing.get(triggerId) !== pauseToken) return undefined;
        const active = this.#active.get(triggerId);
        active?.abort.abort(error);
        return active;
      });
      if (occurrence) await occurrence.promise;
      await this.#retryTriggerLease(
        () => this.#queue.run(async () => {
          if (this.#binding?.projectId !== binding.projectId || this.#stopping || lifecycle.aborted ||
            this.#pausing.get(triggerId) !== pauseToken) return;
          await this.#pauseFilesystemDefinition(binding, triggerId, failure, occurrence?.runId);
        }),
        lifecycle,
      );
    } catch (persistenceError) {
      if (!this.#stopping && !lifecycle.aborted) {
        host?.notify(
          `${triggerId}: filesystem trigger could not be persisted as paused — ${errorMessage(persistenceError)}`,
          "error",
        );
      }
    } finally {
      if (this.#pausing.get(triggerId) === pauseToken) this.#pausing.delete(triggerId);
    }
  }

  async #pauseFilesystemDefinition(
    binding: ProjectBinding,
    triggerId: string,
    failure?: FilesystemFailureRecord,
    settledRunId?: string,
  ): Promise<void> {
    await this.#withMutableStore(binding, async (store) => {
      let current = await store.load(triggerId);
      if (!current || current.source.kind !== "filesystem") return;
      if (failure !== undefined) await store.saveFailure(failure);
      if (isActiveOccurrence(current)) {
        if (!settledRunId || current.activeRunId !== settledRunId) throw new TriggerPausePendingError(triggerId);
        current = interruptTriggerOccurrence(current, settledRunId, this.#now());
      }
      if (current.state !== "paused") await store.save(pauseTrigger(current, this.#now()));
    });
  }

  #filesystemFailureReason(error: unknown): string {
    const message = errorMessage(error).trim() || "Unknown filesystem watcher failure";
    return truncateUtf8(message, MAX_TRIGGER_FAILURE_REASON_BYTES);
  }

  #failureRecord(triggerId: string, reason: string): FilesystemFailureRecord {
    return {
      schemaVersion: 1,
      triggerId,
      reason,
      failedAt: this.#now().toISOString(),
    };
  }

  async #reconcileStoredTriggers(): Promise<void> {
    const binding = this.#binding;
    if (!binding) return;
    for (const trigger of await new TriggerStore(this.#dataRoot, binding.projectId).list()) {
      if (!isActiveOccurrence(trigger)) continue;
      let claim: WriterLease | undefined;
      try {
        claim = await this.#claims.acquire(binding, trigger.triggerId);
      } catch (error) {
        if (error instanceof LeaseUnavailableError) continue;
        throw error;
      }
      try {
        await this.#withMutableStore(binding, async (store) => {
          const latest = await store.load(trigger.triggerId);
          if (latest && isActiveOccurrence(latest) && latest.activeRunId) {
            await store.save(interruptTriggerOccurrence(latest, latest.activeRunId, this.#now()));
          }
        });
      } finally {
        await this.#claims.release(claim);
      }
    }
  }

  async #withMutableStore<T>(binding: ProjectBinding, operation: (store: TriggerStore) => Promise<T>): Promise<T> {
    return withWriterLease(
      triggerLeasePath(this.#dataRoot, binding.projectId),
      TRIGGER_LEASE_STALE_MS,
      this.#now(),
      (lease) => operation(new TriggerStore(this.#dataRoot, binding.projectId, lease)),
    );
  }

}
