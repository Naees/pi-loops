import { rm, stat, utimes } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { canTransition, transitionRun } from "../controller/state-machine.js";
import { isProjectId, isRunId, isScheduleId } from "../shared/ids.js";
import { RUN_MODES, RUN_STATES, type RunRecord, type RunState } from "../shared/types.js";
import { hasOnlyKeys, isPositiveSafeInteger, isRecord, isRunBudget, isStringArray } from "../shared/validation.js";
import { writeJsonAtomic } from "./atomic-file.js";
import { listRecordIds, readBoundedJsonFile } from "./json-record-files.js";
import { assertWriterLease, type WriterLease } from "./lease.js";
import { selectRetentionEvictions } from "./retention.js";

const MAX_RUN_RECORD_BYTES = 2 * 1024 * 1024;
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

function isStoredEvidence(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, ["verifierId", "criterion", "command", "observed", "passed", "summary", "toolCallId"])) {
    return false;
  }
  return (
    typeof value.verifierId === "string" && value.verifierId.length <= 128 &&
    typeof value.criterion === "string" && Buffer.byteLength(value.criterion, "utf8") <= 4 * 1024 &&
    typeof value.command === "string" && Buffer.byteLength(value.command, "utf8") <= 4 * 1024 &&
    typeof value.observed === "boolean" &&
    typeof value.passed === "boolean" &&
    typeof value.summary === "string" && Buffer.byteLength(value.summary, "utf8") <= 16 * 1024 &&
    (value.toolCallId === undefined || typeof value.toolCallId === "string")
  );
}

function isStoredEvaluation(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, ["complete", "needsUser", "reason", "failedCriteria", "feedback"])) return false;
  return (
    typeof value.complete === "boolean" &&
    typeof value.needsUser === "boolean" &&
    typeof value.reason === "string" && value.reason.trim().length > 0 && Buffer.byteLength(value.reason, "utf8") <= 8 * 1024 &&
    isStringArray(value.failedCriteria) && value.failedCriteria.length <= 50 &&
    value.failedCriteria.every((criterion) => Buffer.byteLength(criterion, "utf8") <= 4 * 1024) &&
    (typeof value.feedback === "string" || value.feedback === null) &&
    (typeof value.feedback !== "string" || Buffer.byteLength(value.feedback, "utf8") <= 16 * 1024) &&
    !(value.complete && value.needsUser) &&
    !(value.complete && value.failedCriteria.length > 0)
  );
}

function isStoredWorker(value: unknown, runId: string): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "repositoryRoot",
    "baseCommit",
    "branch",
    "worktreePath",
    "sessionDirectory",
    "sessionId",
    "sessionFile",
    "childPid",
    "ownershipToken",
    "piVersion",
    "reviewCommit",
    "worktreeRetained",
  ])) return false;
  return (
    typeof value.repositoryRoot === "string" && isAbsolute(value.repositoryRoot) && Buffer.byteLength(value.repositoryRoot, "utf8") <= 16 * 1024 &&
    typeof value.baseCommit === "string" && /^[0-9a-f]{40,64}$/.test(value.baseCommit) &&
    value.branch === `pi-loops/${runId}` &&
    typeof value.worktreePath === "string" && isAbsolute(value.worktreePath) && Buffer.byteLength(value.worktreePath, "utf8") <= 16 * 1024 &&
    typeof value.sessionDirectory === "string" && isAbsolute(value.sessionDirectory) && Buffer.byteLength(value.sessionDirectory, "utf8") <= 16 * 1024 &&
    (value.sessionId === undefined || (typeof value.sessionId === "string" && value.sessionId.trim().length > 0 && value.sessionId.length <= 128)) &&
    (value.sessionFile === undefined || (typeof value.sessionFile === "string" && isAbsolute(value.sessionFile) && Buffer.byteLength(value.sessionFile, "utf8") <= 16 * 1024)) &&
    ((value.sessionId === undefined) === (value.sessionFile === undefined)) &&
    (value.childPid === undefined || isPositiveSafeInteger(value.childPid)) &&
    (value.ownershipToken === undefined || (typeof value.ownershipToken === "string" && value.ownershipToken.length <= 128)) &&
    (value.piVersion === undefined || (typeof value.piVersion === "string" && value.piVersion.length <= 64)) &&
    (value.reviewCommit === undefined || (typeof value.reviewCommit === "string" && /^[0-9a-f]{40,64}$/.test(value.reviewCommit))) &&
    typeof value.worktreeRetained === "boolean"
  );
}

function isBudgetHistoryEntry(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, ["epoch", "budget", "cycles", "activeMs", "endedAt", "reason"])) return false;
  return (
    isPositiveSafeInteger(value.epoch) &&
    isRunBudget(value.budget) &&
    Number.isSafeInteger(value.cycles) &&
    (value.cycles as number) >= 0 &&
    Number.isSafeInteger(value.activeMs) &&
    (value.activeMs as number) >= 0 &&
    typeof value.endedAt === "string" &&
    Number.isFinite(Date.parse(value.endedAt)) &&
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
      "constraints",
      "verifierCommands",
      "budget",
      "budgetEpoch",
      "budgetHistory",
      "cycle",
      "totalCycles",
      "activeMs",
      "budgetDeadlineAt",
      "progressSignature",
      "equivalentFailures",
      "latestWorkerSummary",
      "latestEvidence",
      "latestEvaluation",
      "createdAt",
      "updatedAt",
      "transitions",
      "terminalReason",
      "failureRecoverable",
      "worker",
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.runId !== "string" ||
    !isRunId(value.runId) ||
    typeof value.projectId !== "string" ||
    !isProjectId(value.projectId) ||
    (value.scheduleId !== undefined && (typeof value.scheduleId !== "string" || !isScheduleId(value.scheduleId))) ||
    typeof value.mode !== "string" ||
    !RUN_MODES.includes(value.mode as (typeof RUN_MODES)[number]) ||
    typeof value.state !== "string" ||
    !RUN_STATES.includes(value.state as RunState) ||
    typeof value.goal !== "string" ||
    value.goal.trim().length === 0 ||
    Buffer.byteLength(value.goal, "utf8") > 32 * 1024 ||
    (value.constraints !== undefined &&
      (!isStringArray(value.constraints) || value.constraints.length > 50 ||
        value.constraints.some((item) => Buffer.byteLength(item, "utf8") > 4 * 1024))) ||
    (value.verifierCommands !== undefined &&
      (!isStringArray(value.verifierCommands) || value.verifierCommands.length > 20 ||
        value.verifierCommands.some((item) => Buffer.byteLength(item, "utf8") > 4 * 1024))) ||
    !isRunBudget(value.budget) ||
    (value.budgetEpoch !== undefined && !isPositiveSafeInteger(value.budgetEpoch)) ||
    (value.budgetHistory !== undefined &&
      (!Array.isArray(value.budgetHistory) || value.budgetHistory.length > 1_000 || !value.budgetHistory.every(isBudgetHistoryEntry))) ||
    !Number.isSafeInteger(value.cycle) ||
    (value.cycle as number) < 0 ||
    (value.totalCycles !== undefined && (!Number.isSafeInteger(value.totalCycles) || (value.totalCycles as number) < 0)) ||
    (value.activeMs !== undefined && (!Number.isSafeInteger(value.activeMs) || (value.activeMs as number) < 0)) ||
    (value.budgetDeadlineAt !== undefined && (typeof value.budgetDeadlineAt !== "string" ||
      !Number.isFinite(Date.parse(value.budgetDeadlineAt)) || new Date(value.budgetDeadlineAt).toISOString() !== value.budgetDeadlineAt)) ||
    (value.progressSignature !== undefined && typeof value.progressSignature !== "string") ||
    (value.equivalentFailures !== undefined && (!Number.isSafeInteger(value.equivalentFailures) || (value.equivalentFailures as number) < 0)) ||
    (value.latestWorkerSummary !== undefined &&
      (typeof value.latestWorkerSummary !== "string" || Buffer.byteLength(value.latestWorkerSummary, "utf8") > 32 * 1024)) ||
    (value.latestEvidence !== undefined && (!Array.isArray(value.latestEvidence) || !value.latestEvidence.every(isStoredEvidence))) ||
    (value.latestEvaluation !== undefined && !isStoredEvaluation(value.latestEvaluation)) ||
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
    (value.state !== "failed" && value.failureRecoverable !== undefined) ||
    (value.worker !== undefined && !isStoredWorker(value.worker, value.runId)) ||
    (value.mode === "goal" && value.worker !== undefined) ||
    (value.mode !== "goal" && value.state === "completed" &&
      (!isRecord(value.worker) || value.worker.reviewCommit === undefined || value.worker.worktreeRetained !== false))
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
  if (!isProjectId(projectId)) throw new Error(`Invalid project ID: ${projectId}`);
  return join(dataRoot, "projects", projectId, "writer.lease.json");
}

export class RunStore {
  readonly #projectId: string;
  readonly #runsDirectory: string;
  readonly #sessionsDirectory: string;
  readonly #expectedLeasePath: string;
  readonly #lease: WriterLease | undefined;

  constructor(dataRoot: string, projectId: string, lease?: WriterLease) {
    if (!isProjectId(projectId)) throw new Error(`Invalid project ID: ${projectId}`);
    this.#projectId = projectId;
    this.#runsDirectory = join(dataRoot, "projects", projectId, "runs");
    this.#sessionsDirectory = join(dataRoot, "projects", projectId, "sessions");
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
    if (Buffer.byteLength(JSON.stringify(run), "utf8") > MAX_RUN_RECORD_BYTES) {
      throw new Error(`Run record exceeds ${MAX_RUN_RECORD_BYTES} bytes`);
    }
    await writeJsonAtomic(this.#path(run.runId), run);
  }

  async load(runId: string): Promise<RunRecord | undefined> {
    const value = await readBoundedJsonFile(
      this.#path(runId),
      MAX_RUN_RECORD_BYTES,
      `Run record exceeds ${MAX_RUN_RECORD_BYTES} bytes`,
    );
    if (value === undefined) return undefined;
    const run = parseRunRecord(value);
    if (run.projectId !== this.#projectId) throw new Error("Stored run belongs to a different project");
    return run;
  }

  async list(): Promise<RunRecord[]> {
    const runs: RunRecord[] = [];
    for (const runId of await listRecordIds(this.#runsDirectory, /^(run_[0-9a-f]{8})\.json$/)) {
      const run = await this.load(runId);
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
    const runPath = this.#path(runId);
    await rm(join(this.#sessionsDirectory, runId), { recursive: true, force: true });
    await rm(runPath, { force: true });
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
