import type { ProjectBinding } from "../contracts/project-binding.js";
import type { RunBudget, RunRecord, ScheduleRecord, TriggerRecord } from "../shared/types.js";
import { isResumableRun } from "./state-machine.js";

export interface UnattendedDefinition {
  readonly mode: "scheduled" | "proactive";
  readonly sourceId: string;
  readonly projectId: string;
  readonly projectRoot: string;
  readonly goal: string;
  readonly constraints: readonly string[];
  readonly verifierCommands: readonly string[];
  readonly budget: RunBudget;
}

export function scheduleDefinition(schedule: ScheduleRecord): UnattendedDefinition {
  return {
    mode: "scheduled",
    sourceId: schedule.scheduleId,
    projectId: schedule.projectId,
    projectRoot: schedule.projectRoot,
    goal: schedule.goal,
    constraints: schedule.constraints,
    verifierCommands: schedule.verifierCommands,
    budget: schedule.budget,
  };
}

export function triggerDefinition(trigger: TriggerRecord): UnattendedDefinition {
  return {
    mode: "proactive",
    sourceId: trigger.triggerId,
    projectId: trigger.projectId,
    projectRoot: trigger.projectRoot,
    goal: trigger.goal,
    constraints: trigger.constraints,
    verifierCommands: trigger.verifierCommands,
    budget: trigger.budget,
  };
}

export function unattendedLabel(definition: UnattendedDefinition): "Scheduled" | "Proactive" {
  return definition.mode === "scheduled" ? "Scheduled" : "Proactive";
}

export function createUnattendedRun(
  binding: ProjectBinding,
  definition: UnattendedDefinition,
  runId: string,
  createdAt: string,
): RunRecord {
  return {
    schemaVersion: 1,
    runId,
    projectId: binding.projectId,
    ...(definition.mode === "scheduled" ? { scheduleId: definition.sourceId } : { triggerId: definition.sourceId }),
    mode: definition.mode,
    state: "configuring",
    goal: definition.goal,
    constraints: definition.constraints,
    verifierCommands: definition.verifierCommands,
    budget: definition.budget,
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
}

export function prepareUnattendedRestart(run: RunRecord, now: Date): RunRecord {
  const resumed: { -readonly [Key in keyof RunRecord]: RunRecord[Key] } = { ...run };
  delete resumed.terminalReason;
  delete resumed.failureRecoverable;
  if (run.state === "stalled" || run.state === "budget_exhausted") {
    resumed.budgetEpoch = (run.budgetEpoch ?? 1) + 1;
    resumed.budgetHistory = [
      ...(run.budgetHistory ?? []),
      {
        epoch: run.budgetEpoch ?? 1,
        budget: run.budget,
        cycles: run.cycle,
        activeMs: run.activeMs ?? 0,
        endedAt: now.toISOString(),
        reason: run.terminalReason ?? run.state,
      },
    ];
    resumed.cycle = 0;
    resumed.activeMs = 0;
    resumed.equivalentFailures = 0;
    delete resumed.progressSignature;
    delete resumed.budgetDeadlineAt;
  }
  return resumed;
}

export function isSafeUnattendedRestart(run: RunRecord, definition: UnattendedDefinition): boolean {
  const awaitingPreflightRetry = run.state === "awaiting_user" && run.worker === undefined;
  const resumableWorker = run.worker?.worktreeRetained === true && run.worker.reviewCommit === undefined &&
    Boolean(run.worker.sessionFile && run.worker.sessionId && run.budgetDeadlineAt);
  const sourceMatches = definition.mode === "scheduled"
    ? run.scheduleId === definition.sourceId && run.triggerId === undefined
    : run.triggerId === definition.sourceId && run.scheduleId === undefined;
  return run.mode === definition.mode &&
    sourceMatches &&
    run.goal === definition.goal &&
    sameStringList(run.constraints, definition.constraints) &&
    sameStringList(run.verifierCommands, definition.verifierCommands) &&
    sameBudget(run.budget, definition.budget) &&
    isResumableRun(run) &&
    (awaitingPreflightRetry || resumableWorker);
}

function sameStringList(left: readonly string[] | undefined, right: readonly string[]): boolean {
  const resolvedLeft = left ?? [];
  return resolvedLeft.length === right.length && resolvedLeft.every((value, index) => value === right[index]);
}

function sameBudget(left: RunBudget, right: RunBudget): boolean {
  return left.maxActiveMs === right.maxActiveMs &&
    left.maxCycles === right.maxCycles &&
    left.stallThreshold === right.stallThreshold;
}
