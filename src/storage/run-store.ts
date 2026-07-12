import { readdir, readFile, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { canTransition, transitionRun } from "../controller/state-machine.js";
import { isRunId, isScheduleId } from "../shared/ids.js";
import { RUN_MODES, RUN_STATES, type RunRecord, type RunState } from "../shared/types.js";
import { writeJsonAtomic } from "./atomic-file.js";
import { assertWriterLease, type WriterLease } from "./lease.js";
import { selectRetentionEvictions } from "./retention.js";

const PROJECT_ID_PATTERN = /^project_[0-9a-f]{16}$/;
const ACTIVE_CRASH_STATES = new Set<RunState>([
  "configuring",
  "preflight",
  "queued",
  "starting",
  "running",
  "verifying",
  "evaluating",
  "finalizing",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function isTransition(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, ["from", "to", "at", "reason"])) return false;
  return (
    (value.from === null || (typeof value.from === "string" && RUN_STATES.includes(value.from as RunState))) &&
    typeof value.to === "string" &&
    RUN_STATES.includes(value.to as RunState) &&
    typeof value.at === "string" &&
    Number.isFinite(Date.parse(value.at)) &&
    typeof value.reason === "string" &&
    value.reason.trim().length > 0
  );
}

function hasCoherentTransitionChain(value: Record<string, unknown>): boolean {
  const state = value.state as RunState;
  const transitions = value.transitions as { from: RunState | null; to: RunState; at: string }[];
  if (transitions.length === 0) return state === "configuring";

  let expectedFrom: RunState = "configuring";
  for (const transition of transitions) {
    if (transition.from !== expectedFrom || !canTransition(transition.from, transition.to)) return false;
    expectedFrom = transition.to;
  }
  const last = transitions.at(-1);
  return last?.to === state && last.at === value.updatedAt;
}

function parseRunRecord(value: unknown): RunRecord {
  if (!isRecord(value)) throw new Error("Run record must be an object");
  if (
    !hasOnlyKeys(value, [
      "schemaVersion",
      "runId",
      "projectId",
      "scheduleId",
      "mode",
      "state",
      "goal",
      "budget",
      "cycle",
      "createdAt",
      "updatedAt",
      "transitions",
      "terminalReason",
      "failureRecoverable",
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.runId !== "string" ||
    !isRunId(value.runId) ||
    typeof value.projectId !== "string" ||
    !PROJECT_ID_PATTERN.test(value.projectId) ||
    (value.scheduleId !== undefined && (typeof value.scheduleId !== "string" || !isScheduleId(value.scheduleId))) ||
    typeof value.mode !== "string" ||
    !RUN_MODES.includes(value.mode as (typeof RUN_MODES)[number]) ||
    typeof value.state !== "string" ||
    !RUN_STATES.includes(value.state as RunState) ||
    typeof value.goal !== "string" ||
    value.goal.trim().length === 0 ||
    !isRecord(value.budget) ||
    !hasOnlyKeys(value.budget, ["maxActiveMs", "maxCycles", "stallThreshold"]) ||
    !isPositiveSafeInteger(value.budget.maxActiveMs) ||
    !isPositiveSafeInteger(value.budget.maxCycles) ||
    !isPositiveSafeInteger(value.budget.stallThreshold) ||
    !Number.isSafeInteger(value.cycle) ||
    (value.cycle as number) < 0 ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    typeof value.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.updatedAt)) ||
    !Array.isArray(value.transitions) ||
    !value.transitions.every(isTransition) ||
    !hasCoherentTransitionChain(value) ||
    (value.terminalReason !== undefined && (typeof value.terminalReason !== "string" || value.terminalReason.trim().length === 0)) ||
    (value.failureRecoverable !== undefined && typeof value.failureRecoverable !== "boolean") ||
    (value.state === "failed" && (typeof value.failureRecoverable !== "boolean" || typeof value.terminalReason !== "string")) ||
    (value.state !== "failed" && value.failureRecoverable !== undefined)
  ) {
    throw new Error("Run record has an invalid shape");
  }
  return value as unknown as RunRecord;
}

function runFileName(runId: string): string {
  if (!isRunId(runId)) throw new Error(`Invalid run ID: ${runId}`);
  return `${runId}.json`;
}

export function writerLeasePath(dataRoot: string, projectId: string): string {
  if (!PROJECT_ID_PATTERN.test(projectId)) throw new Error(`Invalid project ID: ${projectId}`);
  return join(dataRoot, "projects", projectId, "writer.lease.json");
}

export class RunStore {
  readonly #projectId: string;
  readonly #runsDirectory: string;
  readonly #expectedLeasePath: string;
  readonly #lease: WriterLease | undefined;

  constructor(dataRoot: string, projectId: string, lease?: WriterLease) {
    if (!PROJECT_ID_PATTERN.test(projectId)) throw new Error(`Invalid project ID: ${projectId}`);
    this.#projectId = projectId;
    this.#runsDirectory = join(dataRoot, "projects", projectId, "runs");
    this.#expectedLeasePath = writerLeasePath(dataRoot, projectId);
    if (lease !== undefined && lease.path !== this.#expectedLeasePath) {
      throw new Error("Writer lease does not belong to this project store");
    }
    this.#lease = lease;
  }

  async save(run: RunRecord): Promise<void> {
    await this.#assertMutationLease();
    if (run.projectId !== this.#projectId) throw new Error("Run project ID does not match this store");
    parseRunRecord(run);
    await writeJsonAtomic(this.#path(run.runId), run);
  }

  async load(runId: string): Promise<RunRecord | undefined> {
    const path = this.#path(runId);
    try {
      const run = parseRunRecord(JSON.parse(await readFile(path, "utf8")) as unknown);
      if (run.projectId !== this.#projectId) throw new Error("Stored run belongs to a different project");
      return run;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async list(): Promise<RunRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.#runsDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const runs: RunRecord[] = [];
    for (const name of names.sort()) {
      if (!/^run_[0-9a-f]{8}\.json$/.test(name)) continue;
      const run = await this.load(name.slice(0, -5));
      if (run) runs.push(run);
    }
    return runs;
  }

  async markAccessed(runId: string, at: Date = new Date()): Promise<void> {
    await this.#assertMutationLease();
    const path = this.#path(runId);
    await utimes(path, at, at);
  }

  async delete(runId: string): Promise<void> {
    await this.#assertMutationLease();
    await rm(this.#path(runId), { force: true });
  }

  async reconcileInterrupted(now: Date = new Date()): Promise<string[]> {
    await this.#assertMutationLease();
    const reconciled: string[] = [];
    for (const run of await this.list()) {
      if (!ACTIVE_CRASH_STATES.has(run.state)) continue;
      const interrupted = transitionRun(run, "interrupted", "Pi process ended before the run settled", now);
      await this.save(interrupted);
      reconciled.push(run.runId);
    }
    return reconciled;
  }

  async enforceRetention(limit: number, eligible: (run: RunRecord) => boolean): Promise<string[]> {
    await this.#assertMutationLease();
    const candidates = [];
    for (const run of await this.list()) {
      const metadata = await stat(this.#path(run.runId));
      candidates.push({ runId: run.runId, lastUsedMs: metadata.mtimeMs, eligible: eligible(run) });
    }

    const evictions = selectRetentionEvictions(candidates, limit);
    await Promise.all(evictions.map((runId) => this.delete(runId)));
    return evictions;
  }

  async #assertMutationLease(): Promise<void> {
    if (!this.#lease) throw new Error("Run-store mutation requires the project writer lease");
    await assertWriterLease(this.#lease);
  }

  #path(runId: string): string {
    return join(this.#runsDirectory, runFileName(runId));
  }
}
