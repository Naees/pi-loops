export const RUN_STATES = [
  "configuring",
  "preflight",
  "queued",
  "starting",
  "running",
  "verifying",
  "evaluating",
  "finalizing",
  "awaiting_user",
  "completed",
  "failed",
  "cancelled",
  "budget_exhausted",
  "stalled",
  "interrupted",
] as const;

export type RunState = (typeof RUN_STATES)[number];

export const RUN_MODES = ["goal", "scheduled", "proactive"] as const;
export type RunMode = (typeof RUN_MODES)[number];

export const SCHEDULE_STATES = ["enabled", "running", "pending_coalesced", "paused"] as const;
export type ScheduleState = (typeof SCHEDULE_STATES)[number];

export type SchedulePauseReason = "completed" | "missed" | "interrupted" | "user";

export type ScheduleTiming =
  | { readonly kind: "once"; readonly fireAt: string }
  | { readonly kind: "recurring"; readonly intervalMs: number; readonly anchorAt: string };

export interface RunBudget {
  readonly maxActiveMs: number;
  readonly maxCycles: number;
  readonly stallThreshold: number;
}

export interface RunTransition {
  readonly from: RunState | null;
  readonly to: RunState;
  readonly at: string;
  readonly reason: string;
}

export interface StoredVerifierEvidence {
  readonly verifierId: string;
  readonly criterion: string;
  readonly command: string;
  readonly observed: boolean;
  readonly passed: boolean;
  readonly summary: string;
  readonly toolCallId?: string;
}

export interface StoredEvaluationDecision {
  readonly complete: boolean;
  readonly needsUser: boolean;
  readonly reason: string;
  readonly failedCriteria: readonly string[];
  readonly feedback: string | null;
}

export interface BudgetHistoryEntry {
  readonly epoch: number;
  readonly budget: RunBudget;
  readonly cycles: number;
  readonly activeMs: number;
  readonly endedAt: string;
  readonly reason: string;
}

export interface ScheduleRecord {
  readonly schemaVersion: 1;
  readonly scheduleId: string;
  readonly projectId: string;
  readonly projectRoot: string;
  readonly state: ScheduleState;
  readonly goal: string;
  readonly constraints: readonly string[];
  readonly verifierCommands: readonly string[];
  readonly budget: RunBudget;
  readonly expression: string;
  readonly normalizedExpression: string;
  readonly timing: ScheduleTiming;
  readonly nextFireAt?: string;
  readonly activeRunId?: string;
  readonly pendingSince?: string;
  readonly lastTriggeredAt?: string;
  readonly lastCompletedAt?: string;
  readonly pauseReason?: SchedulePauseReason;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UnattendedWorkerRecord {
  readonly repositoryRoot: string;
  readonly baseCommit: string;
  readonly branch: string;
  readonly worktreePath: string;
  readonly sessionDirectory: string;
  readonly sessionId?: string;
  readonly sessionFile?: string;
  readonly childPid?: number;
  readonly ownershipToken?: string;
  readonly piVersion?: string;
  readonly reviewCommit?: string;
  readonly worktreeRetained: boolean;
}

export interface RunRecord {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly projectId: string;
  readonly scheduleId?: string;
  readonly mode: RunMode;
  readonly state: RunState;
  readonly goal: string;
  readonly constraints?: readonly string[];
  readonly verifierCommands?: readonly string[];
  readonly budget: RunBudget;
  readonly budgetEpoch?: number;
  readonly budgetHistory?: readonly BudgetHistoryEntry[];
  readonly cycle: number;
  readonly totalCycles?: number;
  readonly activeMs?: number;
  readonly budgetDeadlineAt?: string;
  readonly progressSignature?: string;
  readonly equivalentFailures?: number;
  readonly latestWorkerSummary?: string;
  readonly latestEvidence?: readonly StoredVerifierEvidence[];
  readonly latestEvaluation?: StoredEvaluationDecision;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly transitions: readonly RunTransition[];
  readonly terminalReason?: string;
  readonly failureRecoverable?: boolean;
  readonly worker?: UnattendedWorkerRecord;
}
