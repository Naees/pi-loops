import { createCompletionContract } from "../contracts/completion-contract.js";
import { resolveProjectBinding, type ProjectBinding } from "../contracts/project-binding.js";
import { resolveBudget, createUniqueRunId } from "../controller/attended-goal-support.js";
import { isResumableRun } from "../controller/state-machine.js";
import { AsyncSerialQueue } from "../shared/async-queue.js";
import { errorMessage } from "../shared/errors.js";
import { createTriggerId, isRunId, isTriggerId } from "../shared/ids.js";
import type { RunBudget, TriggerRecord } from "../shared/types.js";
import { acquireWriterLease, LeaseUnavailableError, releaseWriterLease, type WriterLease } from "../storage/lease.js";
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
import { FilesystemTriggerManager, resolveFilesystemTarget } from "./filesystem.js";

const TRIGGER_LEASE_STALE_MS = 30_000;
const CLAIM_LEASE_STALE_MS = 30_000;
const EVENT_DEBOUNCE_MS = 250;
const MAX_EVENT_IDS_PER_TRIGGER = 128;
const MAX_EVENT_INGRESS = 64;

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

export type TriggerOccurrenceKind = "start" | "restart";
export type TriggerOccurrenceRunner = (
  trigger: TriggerRecord,
  runId: string,
  signal: AbortSignal,
  kind: TriggerOccurrenceKind,
) => Promise<{ readonly status: "finished" | "interrupted" }>;

interface ActiveOccurrence {
  readonly runId: string;
  readonly abort: AbortController;
  readonly claim: WriterLease;
  readonly promise: Promise<void>;
}

interface EventIngress {
  currentEventId: string | undefined;
  pending: boolean;
  pendingEventId: string | undefined;
}

export class TriggerController {
  readonly #dataRoot: string;
  readonly #now: () => Date;
  readonly #claims: TriggerClaimManager;
  readonly #watchers: FilesystemTriggerManager;
  readonly #queue = new AsyncSerialQueue();
  readonly #active = new Map<string, ActiveOccurrence>();
  readonly #pausing = new Set<string>();
  readonly #eventWindows = new Map<string, { untilMs: number; coalesced: boolean }>();
  readonly #eventIds = new Map<string, Set<string>>();
  readonly #eventIngress = new Map<string, EventIngress>();
  #binding: ProjectBinding | undefined;
  #runner: TriggerOccurrenceRunner | undefined;
  #host: TriggerHost | undefined;
  #stopping = false;

  constructor(options: {
    dataRoot?: string;
    now?: () => Date;
    claimLeaseStaleMs?: number;
  } = {}) {
    this.#dataRoot = options.dataRoot ?? resolvePiLoopsDataRoot();
    this.#now = options.now ?? (() => new Date());
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
      onError: (triggerId, error) => this.#host?.notify(`${triggerId}: filesystem trigger failed — ${errorMessage(error)}`, "error"),
    });
  }

  async start(host: TriggerHost, runner: TriggerOccurrenceRunner): Promise<void> {
    await this.#queue.run(async () => {
      if (this.#binding) throw new Error("Trigger controller is already started");
      this.#binding = await resolveProjectBinding(host.cwd);
      this.#runner = runner;
      this.#host = host;
      this.#stopping = false;
      try {
        await this.#reconcileStoredTriggers();
        for (const trigger of await new TriggerStore(this.#dataRoot, this.#binding.projectId).list()) {
          try {
            await this.#watchers.upsert(trigger);
          } catch (error) {
            host.notify(`${trigger.triggerId}: filesystem watcher could not start — ${errorMessage(error)}`, "warning");
          }
        }
      } catch (error) {
        this.#watchers.shutdown();
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
          triggerId: await this.#createUniqueTriggerId(store),
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

  async fireEvent(triggerId: string, cwd: string, eventId?: string): Promise<"started" | "coalesced" | "ignored"> {
    if (!isTriggerId(triggerId)) throw new Error(`Invalid trigger ID: ${triggerId}`);
    const seen = this.#eventIds.get(triggerId);
    if (eventId && seen?.has(eventId)) return "ignored";

    const ingress = this.#eventIngress.get(triggerId);
    if (ingress) {
      if (eventId && (eventId === ingress.currentEventId || eventId === ingress.pendingEventId)) return "ignored";
      const window = this.#eventWindows.get(triggerId);
      if (ingress.pending || window?.coalesced) return "coalesced";
      ingress.pending = true;
      ingress.pendingEventId = eventId;
      if (window) window.coalesced = true;
      return "coalesced";
    }

    const nowMs = this.#now().getTime();
    const window = this.#eventWindows.get(triggerId);
    if (window && nowMs < window.untilMs) {
      if (window.coalesced) return "coalesced";
      window.coalesced = true;
    } else {
      this.#eventWindows.set(triggerId, { untilMs: nowMs + EVENT_DEBOUNCE_MS, coalesced: false });
    }
    if (this.#eventIngress.size >= MAX_EVENT_INGRESS) throw new Error("Pi Loops trigger event ingress is at capacity");

    const admitted: EventIngress = { currentEventId: eventId, pending: false, pendingEventId: undefined };
    this.#eventIngress.set(triggerId, admitted);
    try {
      const initial = await this.fire(triggerId, cwd, "event");
      this.#rememberEventId(triggerId, eventId);
      while (admitted.pending) {
        const pendingEventId = admitted.pendingEventId;
        admitted.pending = false;
        admitted.currentEventId = pendingEventId;
        admitted.pendingEventId = undefined;
        await this.fire(triggerId, cwd, "event");
        this.#rememberEventId(triggerId, pendingEventId);
      }
      return initial;
    } catch (error) {
      this.#eventWindows.delete(triggerId);
      throw error;
    } finally {
      this.#eventIngress.delete(triggerId);
    }
  }

  async fire(triggerId: string, cwd: string, expectedSource?: "event"): Promise<"started" | "coalesced" | "ignored"> {
    if (!isTriggerId(triggerId)) throw new Error(`Invalid trigger ID: ${triggerId}`);
    return this.#queue.run(async () => {
      const binding = await resolveProjectBinding(cwd);
      if (this.#binding?.projectId !== binding.projectId || !this.#runner || this.#stopping) {
        throw new Error("Trigger controller is not running for this project");
      }
      const current = await new TriggerStore(this.#dataRoot, binding.projectId).load(triggerId);
      if (!current || (expectedSource === "event" && current.source.kind !== "event")) {
        throw new Error(expectedSource === "event" ? `Event trigger not found: ${triggerId}` : `Trigger not found: ${triggerId}`);
      }
      if (current.state === "paused") return "ignored";
      const alreadyRunning = current.state === "running" || current.state === "pending_coalesced";
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
          if ((latest.state === "running" || latest.state === "pending_coalesced") && latest.activeRunId) {
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
    if (pauseDefinition) this.#pausing.add(id);
    try {
      if (occurrence) {
        occurrence[1].abort.abort();
        await occurrence[1].promise;
      }
      if (!pauseDefinition) return occurrence?.[0];
      await this.#queue.run(async () => {
        await this.#withMutableStore(binding, async (store) => {
          const trigger = await store.load(id);
          if (!trigger) throw new Error(`Trigger not found: ${id}`);
          await store.save(pauseTrigger(trigger, this.#now()));
        });
        this.#watchers.remove(id);
      });
      return id;
    } finally {
      if (pauseDefinition) this.#pausing.delete(id);
    }
  }

  async enable(triggerId: string, cwd: string): Promise<void> {
    if (!isTriggerId(triggerId)) throw new Error(`Invalid trigger ID: ${triggerId}`);
    await this.#queue.run(async () => {
      const binding = await resolveProjectBinding(cwd);
      if (this.#binding?.projectId !== binding.projectId || this.#stopping) {
        throw new Error("Trigger controller is not running for this project");
      }
      let enabled: TriggerRecord | undefined;
      await this.#withMutableStore(binding, async (store) => {
        const trigger = await store.load(triggerId);
        if (!trigger) throw new Error(`Trigger not found: ${triggerId}`);
        enabled = enableTrigger(trigger, this.#now());
        await store.save(enabled);
      });
      if (enabled?.source.kind === "filesystem") {
        try {
          await this.#watchers.upsert(enabled);
        } catch (error) {
          await this.#withMutableStore(binding, async (store) => {
            const current = await store.load(triggerId);
            if (current?.state === "enabled") await store.save(pauseTrigger(current, this.#now()));
          });
          throw error;
        }
      }
    });
  }

  async resumeOccurrence(triggerId: string, runId: string, cwd: string): Promise<void> {
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
        transferred = this.#launch(resumed, runId, claim, "restart");
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
        if (trigger.state === "running" || trigger.state === "pending_coalesced") {
          throw new Error(`Stop the active proactive run before deleting ${triggerId}`);
        }
        await store.delete(triggerId);
      });
      this.#eventWindows.delete(triggerId);
      this.#eventIds.delete(triggerId);
      this.#eventIngress.delete(triggerId);
      this.#watchers.remove(triggerId);
    });
  }

  async shutdown(): Promise<void> {
    this.#stopping = true;
    this.#watchers.shutdown();
    for (const occurrence of this.#active.values()) occurrence.abort.abort();
    await Promise.allSettled([...this.#active.values()].map((occurrence) => occurrence.promise));
    await this.#queue.run(async () => {
      this.#active.clear();
      this.#eventWindows.clear();
      this.#eventIds.clear();
      this.#eventIngress.clear();
      this.#binding = undefined;
      this.#runner = undefined;
      this.#host = undefined;
    });
  }

  #launch(trigger: TriggerRecord, runId: string, claim: WriterLease, kind: TriggerOccurrenceKind): boolean {
    const runner = this.#runner;
    if (!runner || this.#stopping || claim.signal.aborted) return false;
    const abort = new AbortController();
    const onClaimLoss = (): void => abort.abort(claim.signal.reason);
    claim.signal.addEventListener("abort", onClaimLoss, { once: true });
    const promise = (async () => {
      let transferred = false;
      try {
        let result: { status: "finished" | "interrupted" };
        try {
          result = await runner(trigger, runId, abort.signal, kind);
        } catch (error) {
          result = { status: "interrupted" };
          if (!claim.signal.aborted) this.#host?.notify(`${trigger.triggerId}: proactive occurrence failed — ${errorMessage(error)}`, "error");
        }
        if (!claim.signal.aborted) transferred = await this.#settle(trigger.triggerId, runId, result, claim);
      } finally {
        claim.signal.removeEventListener("abort", onClaimLoss);
        if (!transferred) await this.#claims.release(claim).catch(() => undefined);
      }
    })().finally(() => {
      if (this.#active.get(trigger.triggerId)?.promise !== promise) return;
      this.#active.delete(trigger.triggerId);
    });
    this.#active.set(trigger.triggerId, { runId, abort, claim, promise });
    return true;
  }

  async #settle(
    triggerId: string,
    runId: string,
    result: { status: "finished" | "interrupted" },
    claim: WriterLease,
  ): Promise<boolean> {
    return this.#queue.run(async () => {
      const binding = this.#binding;
      if (!binding) return false;
      await this.#claims.assert(claim);
      let replacement: { trigger: TriggerRecord; runId: string } | undefined;
      await this.#withMutableStore(binding, async (store) => {
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

  #rememberEventId(triggerId: string, eventId: string | undefined): void {
    if (!eventId) return;
    const seen = this.#eventIds.get(triggerId) ?? new Set<string>();
    seen.add(eventId);
    if (seen.size > MAX_EVENT_IDS_PER_TRIGGER) seen.delete(seen.values().next().value as string);
    this.#eventIds.set(triggerId, seen);
  }

  async #coalesce(binding: ProjectBinding, triggerId: string): Promise<void> {
    await this.#withMutableStore(binding, async (store) => {
      const latest = await store.load(triggerId);
      if (!latest?.activeRunId) throw new Error(`Active trigger occurrence is missing its run ID: ${triggerId}`);
      await store.save(fireTrigger(latest, latest.activeRunId, this.#now()).trigger);
    });
  }

  async #reconcileStoredTriggers(): Promise<void> {
    const binding = this.#binding;
    if (!binding) return;
    for (const trigger of await new TriggerStore(this.#dataRoot, binding.projectId).list()) {
      if (trigger.state !== "running" && trigger.state !== "pending_coalesced") continue;
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
          if (latest && (latest.state === "running" || latest.state === "pending_coalesced") && latest.activeRunId) {
            await store.save(interruptTriggerOccurrence(latest, latest.activeRunId, this.#now()));
          }
        });
      } finally {
        await this.#claims.release(claim);
      }
    }
  }

  async #withMutableStore<T>(binding: ProjectBinding, operation: (store: TriggerStore) => Promise<T>): Promise<T> {
    const lease = await acquireWriterLease(triggerLeasePath(this.#dataRoot, binding.projectId), TRIGGER_LEASE_STALE_MS, this.#now());
    try {
      return await operation(new TriggerStore(this.#dataRoot, binding.projectId, lease));
    } finally {
      await releaseWriterLease(lease);
    }
  }

  async #createUniqueTriggerId(store: TriggerStore): Promise<string> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const triggerId = createTriggerId();
      if ((await store.load(triggerId)) === undefined) return triggerId;
    }
    throw new Error("Could not allocate a unique trigger ID");
  }
}
