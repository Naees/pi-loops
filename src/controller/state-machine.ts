import type { RunRecord, RunState } from "../shared/types.js";

const ALLOWED_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  configuring: ["preflight", "awaiting_user", "cancelled", "failed"],
  preflight: ["queued", "starting", "awaiting_user", "cancelled", "failed"],
  queued: ["starting", "cancelled", "interrupted", "failed"],
  starting: ["running", "cancelled", "interrupted", "failed"],
  running: ["verifying", "awaiting_user", "cancelled", "interrupted", "failed"],
  verifying: ["evaluating", "running", "awaiting_user", "cancelled", "budget_exhausted", "stalled", "failed"],
  evaluating: ["finalizing", "running", "awaiting_user", "cancelled", "budget_exhausted", "stalled", "failed"],
  finalizing: ["completed", "awaiting_user", "cancelled", "interrupted", "failed"],
  awaiting_user: ["preflight", "running", "cancelled", "failed"],
  completed: [],
  failed: ["preflight"],
  cancelled: [],
  budget_exhausted: ["preflight"],
  stalled: ["preflight"],
  interrupted: ["preflight"],
};

export class InvalidRunTransitionError extends Error {
  readonly from: RunState;
  readonly to: RunState;

  constructor(from: RunState, to: RunState) {
    super(`Invalid run transition: ${from} -> ${to}`);
    this.name = "InvalidRunTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function canTransition(from: RunState, to: RunState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export interface TransitionOptions {
  readonly failureRecoverable?: boolean;
}

export function transitionRun(
  run: RunRecord,
  to: RunState,
  reason: string,
  at: Date = new Date(),
  options: TransitionOptions = {},
): RunRecord {
  if (!canTransition(run.state, to)) {
    throw new InvalidRunTransitionError(run.state, to);
  }
  if (run.state === "failed" && run.failureRecoverable !== true) {
    throw new InvalidRunTransitionError(run.state, to);
  }
  if (to === "failed" && options.failureRecoverable === undefined) {
    throw new Error("A failed transition must declare whether the failure is recoverable");
  }

  const timestamp = at.toISOString();
  const baseRun: { -readonly [Key in keyof RunRecord]: RunRecord[Key] } = { ...run };
  if (run.state === "failed") {
    delete baseRun.terminalReason;
    delete baseRun.failureRecoverable;
  }
  const failureFields = to === "failed"
    ? { terminalReason: reason, failureRecoverable: options.failureRecoverable as boolean }
    : {};

  return {
    ...baseRun,
    ...failureFields,
    state: to,
    updatedAt: timestamp,
    transitions: [
      ...run.transitions,
      {
        from: run.state,
        to,
        at: timestamp,
        reason,
      },
    ],
  };
}

export function isTerminalState(state: RunState): boolean {
  return state === "completed" || state === "cancelled";
}

export function isRecoverableState(state: RunState): boolean {
  return state === "budget_exhausted" || state === "stalled" || state === "interrupted";
}

export function isRecoverableRun(run: RunRecord): boolean {
  return isRecoverableState(run.state) || (run.state === "failed" && run.failureRecoverable === true);
}
