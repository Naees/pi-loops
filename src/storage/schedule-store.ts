import { readdir, readFile, rm, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { DEFAULT_CONFIG } from "../config/config.js";
import { createProjectId, isRunId, isScheduleId } from "../shared/ids.js";
import {
  SCHEDULE_STATES,
  type RunBudget,
  type SchedulePauseReason,
  type ScheduleRecord,
  type ScheduleState,
  type ScheduleTiming,
} from "../shared/types.js";
import { writeJsonAtomic } from "./atomic-file.js";
import { assertWriterLease, type WriterLease } from "./lease.js";

const PROJECT_ID_PATTERN = /^project_[0-9a-f]{16}$/;
const MAX_SCHEDULE_RECORD_BYTES = 1024 * 1024;
const PAUSE_REASONS: readonly SchedulePauseReason[] = ["completed", "missed", "interrupted", "user"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return false;
  return new Date(value).toISOString() === value;
}

function isStringArray(value: unknown, maximumItems: number, maximumItemBytes: number): value is string[] {
  return Array.isArray(value) && value.length <= maximumItems && value.every((item) =>
    typeof item === "string" && item.trim().length > 0 && Buffer.byteLength(item, "utf8") <= maximumItemBytes);
}

function isBudget(value: unknown): value is RunBudget {
  return isRecord(value) && hasOnlyKeys(value, ["maxActiveMs", "maxCycles", "stallThreshold"]) &&
    isPositiveSafeInteger(value.maxActiveMs) && isPositiveSafeInteger(value.maxCycles) && isPositiveSafeInteger(value.stallThreshold);
}

function parseTiming(value: unknown): ScheduleTiming | undefined {
  if (!isRecord(value) || typeof value.kind !== "string") return undefined;
  if (value.kind === "once" && hasOnlyKeys(value, ["kind", "fireAt"]) && isIsoDate(value.fireAt)) {
    return value as unknown as ScheduleTiming;
  }
  if (value.kind === "recurring" && hasOnlyKeys(value, ["kind", "intervalMs", "anchorAt"]) &&
    isPositiveSafeInteger(value.intervalMs) && value.intervalMs >= DEFAULT_CONFIG.scheduling.minimumRecurringMs && isIsoDate(value.anchorAt)) {
    return value as unknown as ScheduleTiming;
  }
  return undefined;
}

function hasCoherentState(record: Record<string, unknown>, timing: ScheduleTiming): boolean {
  const state = record.state as ScheduleState;
  const hasActive = typeof record.activeRunId === "string" && isRunId(record.activeRunId);
  const hasPending = isIsoDate(record.pendingSince);
  const hasNext = isIsoDate(record.nextFireAt);
  const hasPause = typeof record.pauseReason === "string" && PAUSE_REASONS.includes(record.pauseReason as SchedulePauseReason);

  const timingMatches = timing.kind === "once"
    ? (!hasNext || record.nextFireAt === timing.fireAt)
    : (!hasNext || (Date.parse(record.nextFireAt as string) > Date.parse(timing.anchorAt) &&
      (Date.parse(record.nextFireAt as string) - Date.parse(timing.anchorAt)) % timing.intervalMs === 0));
  if (!timingMatches) return false;
  if (state === "enabled") return !hasActive && !hasPending && !hasPause && hasNext;
  if (state === "running") {
    return hasActive && !hasPending && !hasPause && (timing.kind === "recurring" ? hasNext : !hasNext);
  }
  if (state === "pending_coalesced") {
    return timing.kind === "recurring" && hasActive && hasPending && !hasPause && hasNext;
  }
  return !hasActive && !hasPending && hasPause && !hasNext;
}

export function parseScheduleRecord(value: unknown): ScheduleRecord {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "schemaVersion",
    "scheduleId",
    "projectId",
    "projectRoot",
    "state",
    "goal",
    "constraints",
    "verifierCommands",
    "budget",
    "expression",
    "normalizedExpression",
    "timing",
    "nextFireAt",
    "activeRunId",
    "pendingSince",
    "lastTriggeredAt",
    "lastCompletedAt",
    "pauseReason",
    "createdAt",
    "updatedAt",
  ])) throw new Error("Schedule record has an invalid shape");

  const timing = parseTiming(value.timing);
  if (
    value.schemaVersion !== 1 ||
    typeof value.scheduleId !== "string" || !isScheduleId(value.scheduleId) ||
    typeof value.projectId !== "string" || !PROJECT_ID_PATTERN.test(value.projectId) ||
    typeof value.projectRoot !== "string" || !isAbsolute(value.projectRoot) || createProjectId(value.projectRoot) !== value.projectId ||
    typeof value.state !== "string" || !SCHEDULE_STATES.includes(value.state as ScheduleState) ||
    typeof value.goal !== "string" || value.goal.trim().length === 0 || Buffer.byteLength(value.goal, "utf8") > 16 * 1024 ||
    !isStringArray(value.constraints, 50, 4 * 1024) ||
    !isStringArray(value.verifierCommands, 20, 4 * 1024) ||
    !isBudget(value.budget) ||
    typeof value.expression !== "string" || value.expression.trim().length === 0 || Buffer.byteLength(value.expression, "utf8") > 4 * 1024 ||
    typeof value.normalizedExpression !== "string" || value.normalizedExpression.trim().length === 0 || Buffer.byteLength(value.normalizedExpression, "utf8") > 8 * 1024 ||
    timing === undefined ||
    (value.nextFireAt !== undefined && !isIsoDate(value.nextFireAt)) ||
    (value.activeRunId !== undefined && (typeof value.activeRunId !== "string" || !isRunId(value.activeRunId))) ||
    (value.pendingSince !== undefined && !isIsoDate(value.pendingSince)) ||
    (value.lastTriggeredAt !== undefined && !isIsoDate(value.lastTriggeredAt)) ||
    (value.lastCompletedAt !== undefined && !isIsoDate(value.lastCompletedAt)) ||
    (value.pauseReason !== undefined && (typeof value.pauseReason !== "string" || !PAUSE_REASONS.includes(value.pauseReason as SchedulePauseReason))) ||
    !isIsoDate(value.createdAt) || !isIsoDate(value.updatedAt) ||
    !hasCoherentState(value, timing)
  ) {
    throw new Error("Schedule record has an invalid shape");
  }
  return value as unknown as ScheduleRecord;
}

function scheduleFileName(scheduleId: string): string {
  if (!isScheduleId(scheduleId)) throw new Error(`Invalid schedule ID: ${scheduleId}`);
  return `${scheduleId}.json`;
}

export function scheduleLeasePath(dataRoot: string, projectId: string): string {
  if (!PROJECT_ID_PATTERN.test(projectId)) throw new Error(`Invalid project ID: ${projectId}`);
  return join(dataRoot, "projects", projectId, "schedule-store.lease.json");
}

export class ScheduleStore {
  readonly #projectId: string;
  readonly #directory: string;
  readonly #expectedLeasePath: string;
  readonly #lease: WriterLease | undefined;

  constructor(dataRoot: string, projectId: string, lease?: WriterLease) {
    if (!PROJECT_ID_PATTERN.test(projectId)) throw new Error(`Invalid project ID: ${projectId}`);
    this.#projectId = projectId;
    this.#directory = join(dataRoot, "projects", projectId, "schedules");
    this.#expectedLeasePath = scheduleLeasePath(dataRoot, projectId);
    if (lease && lease.path !== this.#expectedLeasePath) throw new Error("Schedule lease does not belong to this project store");
    this.#lease = lease;
  }

  async save(schedule: ScheduleRecord): Promise<void> {
    await this.#assertMutationLease();
    if (schedule.projectId !== this.#projectId) throw new Error("Schedule project ID does not match this store");
    parseScheduleRecord(schedule);
    if (Buffer.byteLength(JSON.stringify(schedule), "utf8") > MAX_SCHEDULE_RECORD_BYTES) {
      throw new Error(`Schedule record exceeds ${MAX_SCHEDULE_RECORD_BYTES} bytes`);
    }
    await writeJsonAtomic(this.#path(schedule.scheduleId), schedule);
  }

  async load(scheduleId: string): Promise<ScheduleRecord | undefined> {
    const path = this.#path(scheduleId);
    try {
      const metadata = await stat(path);
      if (metadata.size > MAX_SCHEDULE_RECORD_BYTES) throw new Error(`Schedule record exceeds ${MAX_SCHEDULE_RECORD_BYTES} bytes`);
      const schedule = parseScheduleRecord(JSON.parse(await readFile(path, "utf8")) as unknown);
      if (schedule.projectId !== this.#projectId) throw new Error("Stored schedule belongs to a different project");
      return schedule;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async list(): Promise<ScheduleRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.#directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const schedules: ScheduleRecord[] = [];
    for (const name of names.sort()) {
      if (!/^schedule_[0-9a-f]{8}\.json$/.test(name)) continue;
      const schedule = await this.load(name.slice(0, -5));
      if (schedule) schedules.push(schedule);
    }
    return schedules;
  }

  async delete(scheduleId: string): Promise<void> {
    await this.#assertMutationLease();
    await rm(this.#path(scheduleId), { force: true });
  }

  async #assertMutationLease(): Promise<void> {
    if (!this.#lease) throw new Error("Schedule-store mutation requires the project schedule lease");
    await assertWriterLease(this.#lease);
  }

  #path(scheduleId: string): string {
    return join(this.#directory, scheduleFileName(scheduleId));
  }
}
