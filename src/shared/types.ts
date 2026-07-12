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

export interface RunRecord {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly projectId: string;
  readonly scheduleId?: string;
  readonly mode: RunMode;
  readonly state: RunState;
  readonly goal: string;
  readonly budget: RunBudget;
  readonly cycle: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly transitions: readonly RunTransition[];
  readonly terminalReason?: string;
  readonly failureRecoverable?: boolean;
}
