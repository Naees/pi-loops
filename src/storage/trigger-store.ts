import { rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createProjectId, isProjectId, isRunId, isTriggerId } from "../shared/ids.js";
import { TRIGGER_STATES, type TriggerRecord, type TriggerSource, type TriggerState } from "../shared/types.js";
import { hasOnlyKeys, isPositiveSafeInteger, isRecord } from "../shared/validation.js";
import { hasValidStoredCompletionDefinition, isCanonicalIsoDate } from "./record-validation.js";
import { listRecordIds, readBoundedJsonFile, readStoredJsonRecord, writeStoredJsonRecord } from "./json-record-files.js";
import { assertWriterLease, type WriterLease } from "./lease.js";

const MAX_TRIGGER_RECORD_BYTES = 1024 * 1024;
const OVERSIZED_TRIGGER_RECORD = `Trigger record exceeds ${MAX_TRIGGER_RECORD_BYTES} bytes`;
const MAX_TRIGGER_FAILURE_BYTES = 16 * 1024;
const MAX_TRIGGER_FAILURE_REASON_BYTES = 8 * 1024;
export const MAX_TRIGGER_DEFINITIONS = 50;

interface TriggerFailureRecord {
  readonly schemaVersion: 1;
  readonly triggerId: string;
  readonly reason: string;
  readonly failedAt: string;
}

function parseTriggerFailure(value: unknown): TriggerFailureRecord {
  if (!isRecord(value) || !hasOnlyKeys(value, ["schemaVersion", "triggerId", "reason", "failedAt"]) ||
    value.schemaVersion !== 1 || typeof value.triggerId !== "string" || !isTriggerId(value.triggerId) ||
    typeof value.reason !== "string" || value.reason.trim().length === 0 ||
    Buffer.byteLength(value.reason, "utf8") > MAX_TRIGGER_FAILURE_REASON_BYTES ||
    !isCanonicalIsoDate(value.failedAt)) {
    throw new Error("Trigger failure record has an invalid shape");
  }
  return value as unknown as TriggerFailureRecord;
}
const MIN_DEBOUNCE_MS = 100;
const MAX_DEBOUNCE_MS = 60_000;

function parseSource(value: unknown): TriggerSource | undefined {
  if (!isRecord(value) || typeof value.kind !== "string") return undefined;
  if (value.kind === "event" && hasOnlyKeys(value, ["kind"])) return { kind: "event" };
  if (value.kind !== "filesystem" || !hasOnlyKeys(value, ["kind", "relativePath", "debounceMs"])) return undefined;
  if (typeof value.relativePath !== "string" || value.relativePath.trim().length === 0 ||
    Buffer.byteLength(value.relativePath, "utf8") > 16 * 1024 || value.relativePath.includes("\0") ||
    isAbsolute(value.relativePath) || value.relativePath.split(/[\\/]/).includes("..") ||
    !isPositiveSafeInteger(value.debounceMs) || value.debounceMs < MIN_DEBOUNCE_MS || value.debounceMs > MAX_DEBOUNCE_MS) {
    return undefined;
  }
  return value as unknown as TriggerSource;
}

function hasCoherentState(record: Record<string, unknown>): boolean {
  const state = record.state as TriggerState;
  const hasActive = typeof record.activeRunId === "string" && isRunId(record.activeRunId);
  const hasPending = isCanonicalIsoDate(record.pendingSince);
  if (state === "enabled" || state === "paused") return !hasActive && !hasPending;
  if (state === "running") return hasActive && !hasPending;
  return state === "pending_coalesced" && hasActive && hasPending;
}

export function parseTriggerRecord(value: unknown): TriggerRecord {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "schemaVersion",
    "triggerId",
    "projectId",
    "projectRoot",
    "state",
    "goal",
    "constraints",
    "verifierCommands",
    "budget",
    "source",
    "activeRunId",
    "pendingSince",
    "lastTriggeredAt",
    "lastCompletedAt",
    "createdAt",
    "updatedAt",
  ])) throw new Error("Trigger record has an invalid shape");

  const source = parseSource(value.source);
  if (
    value.schemaVersion !== 1 ||
    typeof value.triggerId !== "string" || !isTriggerId(value.triggerId) ||
    typeof value.projectId !== "string" || !isProjectId(value.projectId) ||
    typeof value.projectRoot !== "string" || !isAbsolute(value.projectRoot) || createProjectId(value.projectRoot) !== value.projectId ||
    typeof value.state !== "string" || !TRIGGER_STATES.includes(value.state as TriggerState) ||
    !hasValidStoredCompletionDefinition(value) || source === undefined ||
    (value.activeRunId !== undefined && (typeof value.activeRunId !== "string" || !isRunId(value.activeRunId))) ||
    (value.pendingSince !== undefined && !isCanonicalIsoDate(value.pendingSince)) ||
    (value.lastTriggeredAt !== undefined && !isCanonicalIsoDate(value.lastTriggeredAt)) ||
    (value.lastCompletedAt !== undefined && !isCanonicalIsoDate(value.lastCompletedAt)) ||
    !isCanonicalIsoDate(value.createdAt) || !isCanonicalIsoDate(value.updatedAt) || !hasCoherentState(value)
  ) throw new Error("Trigger record has an invalid shape");
  return value as unknown as TriggerRecord;
}

function triggerFileName(triggerId: string): string {
  if (!isTriggerId(triggerId)) throw new Error(`Invalid trigger ID: ${triggerId}`);
  return `${triggerId}.json`;
}

export function triggerLeasePath(dataRoot: string, projectId: string): string {
  if (!isProjectId(projectId)) throw new Error(`Invalid project ID: ${projectId}`);
  return join(dataRoot, "projects", projectId, "trigger-store.lease.json");
}

export function triggerClaimLeasePath(dataRoot: string, projectId: string, triggerId: string): string {
  if (!isProjectId(projectId)) throw new Error(`Invalid project ID: ${projectId}`);
  if (!isTriggerId(triggerId)) throw new Error(`Invalid trigger ID: ${triggerId}`);
  return join(dataRoot, "projects", projectId, "trigger-claims", `${triggerId}.lease.json`);
}

export class TriggerStore {
  readonly #projectId: string;
  readonly #directory: string;
  readonly #failureDirectory: string;
  readonly #expectedLeasePath: string;
  readonly #lease: WriterLease | undefined;

  constructor(dataRoot: string, projectId: string, lease?: WriterLease) {
    if (!isProjectId(projectId)) throw new Error(`Invalid project ID: ${projectId}`);
    this.#projectId = projectId;
    this.#directory = join(dataRoot, "projects", projectId, "triggers");
    this.#failureDirectory = join(dataRoot, "projects", projectId, "trigger-failures");
    this.#expectedLeasePath = triggerLeasePath(dataRoot, projectId);
    if (lease && lease.path !== this.#expectedLeasePath) throw new Error("Trigger lease does not belong to this project store");
    this.#lease = lease;
  }

  async save(trigger: TriggerRecord): Promise<void> {
    await this.#assertMutationLease();
    if (trigger.projectId !== this.#projectId) throw new Error("Trigger project ID does not match this store");
    parseTriggerRecord(trigger);
    await writeStoredJsonRecord(this.#path(trigger.triggerId), trigger, MAX_TRIGGER_RECORD_BYTES, OVERSIZED_TRIGGER_RECORD);
  }

  async load(triggerId: string): Promise<TriggerRecord | undefined> {
    const path = this.#path(triggerId);
    const loaded = await readStoredJsonRecord(
      path,
      "trigger",
      MAX_TRIGGER_RECORD_BYTES,
      OVERSIZED_TRIGGER_RECORD,
      parseTriggerRecord,
    );
    if (loaded === undefined) return undefined;
    if (loaded.record.projectId !== this.#projectId) throw new Error("Stored trigger belongs to a different project");
    if (loaded.migrated) {
      await this.#assertMutationLease();
      await writeStoredJsonRecord(path, loaded.record, MAX_TRIGGER_RECORD_BYTES, OVERSIZED_TRIGGER_RECORD);
    }
    return loaded.record;
  }

  async list(): Promise<TriggerRecord[]> {
    const triggers: TriggerRecord[] = [];
    const triggerIds = await listRecordIds(this.#directory, /^(trigger_[0-9a-f]{8})\.json$/);
    if (triggerIds.length > MAX_TRIGGER_DEFINITIONS) {
      throw new Error(`Project exceeds the ${MAX_TRIGGER_DEFINITIONS}-trigger definition limit`);
    }
    for (const triggerId of triggerIds) {
      const trigger = await this.load(triggerId);
      if (trigger) triggers.push(trigger);
    }
    return triggers;
  }

  async saveFailure(failure: TriggerFailureRecord): Promise<void> {
    await this.#assertMutationLease();
    parseTriggerFailure(failure);
    await this.loadFailure(failure.triggerId);
    const trigger = await this.load(failure.triggerId);
    if (!trigger || trigger.source.kind !== "filesystem") {
      throw new Error(`Filesystem trigger not found for failure record: ${failure.triggerId}`);
    }
    await writeStoredJsonRecord(
      this.#failurePath(failure.triggerId),
      failure,
      MAX_TRIGGER_FAILURE_BYTES,
      `Trigger failure record exceeds ${MAX_TRIGGER_FAILURE_BYTES} bytes`,
    );
  }

  async loadFailure(triggerId: string): Promise<TriggerFailureRecord | undefined> {
    const value = await readBoundedJsonFile(
      this.#failurePath(triggerId),
      MAX_TRIGGER_FAILURE_BYTES,
      `Trigger failure record exceeds ${MAX_TRIGGER_FAILURE_BYTES} bytes`,
    );
    return value === undefined ? undefined : parseTriggerFailure(value);
  }

  async clearFailure(triggerId: string): Promise<void> {
    await this.#assertMutationLease();
    if (await this.loadFailure(triggerId)) await rm(this.#failurePath(triggerId), { force: true });
  }

  async delete(triggerId: string): Promise<void> {
    await this.#assertMutationLease();
    await Promise.all([
      rm(this.#path(triggerId), { force: true }),
      rm(this.#failurePath(triggerId), { force: true }),
    ]);
  }

  async #assertMutationLease(): Promise<void> {
    if (!this.#lease) throw new Error("Trigger-store mutation requires the project trigger lease");
    await assertWriterLease(this.#lease);
  }

  #path(triggerId: string): string {
    return join(this.#directory, triggerFileName(triggerId));
  }

  #failurePath(triggerId: string): string {
    return join(this.#failureDirectory, triggerFileName(triggerId));
  }
}
