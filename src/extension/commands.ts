import type { GoalResumeRequest } from "../controller/attended-goal-controller.js";
import type { ScheduleCreateRequest } from "../scheduler/scheduler.js";
import type { RunBudget } from "../shared/types.js";

export const LOOP_COMMAND_ACTIONS = ["goal", "schedule", "status", "stop", "resume", "clean", "delete", "help"] as const;

export type LoopCommandAction = (typeof LOOP_COMMAND_ACTIONS)[number] | "unsupported";

export interface ParsedLoopCommand {
  readonly action: LoopCommandAction;
  readonly value: string;
}

function isLoopCommandAction(value: string): value is (typeof LOOP_COMMAND_ACTIONS)[number] {
  return LOOP_COMMAND_ACTIONS.some((action) => action === value);
}

export function parseCommand(args: string): ParsedLoopCommand {
  const trimmed = args.trim();
  if (!trimmed) return { action: "status", value: "" };
  const separator = trimmed.search(/\s/);
  const action = (separator === -1 ? trimmed : trimmed.slice(0, separator)).toLowerCase();
  const value = separator === -1 ? "" : trimmed.slice(separator + 1).trim();
  if (isLoopCommandAction(action)) {
    if (action === "goal" && !value) throw new Error("Usage: /loops goal <goal>");
    if (action === "schedule" && !value) throw new Error("Usage: /loops schedule <time-expression> -- <goal>");
    return { action, value };
  }
  return { action: "unsupported", value: action };
}

export function parseScheduleValue(value: string): ScheduleCreateRequest {
  const separator = value.indexOf(" -- ");
  if (separator <= 0) throw new Error("Usage: /loops schedule <time-expression> -- <goal>");
  const expression = value.slice(0, separator).trim();
  const goal = value.slice(separator + 4).trim();
  if (!expression || !goal) throw new Error("Usage: /loops schedule <time-expression> -- <goal>");
  return { expression, goal };
}

export function parseResumeValue(value: string): GoalResumeRequest {
  if (!value) return {};
  const [first, ...rest] = value.split(/\s+/);
  if (first?.startsWith("run_")) {
    return { runId: first, ...(rest.length === 0 ? {} : { guidance: rest.join(" ") }) };
  }
  return { guidance: value };
}

export function budgetFromTool(params: { maxCycles?: number; maxActiveMinutes?: number }): { budget?: Partial<RunBudget> } {
  const budget = {
    ...(params.maxCycles === undefined ? {} : { maxCycles: params.maxCycles }),
    ...(params.maxActiveMinutes === undefined ? {} : { maxActiveMs: params.maxActiveMinutes * 60_000 }),
  };
  return Object.keys(budget).length === 0 ? {} : { budget };
}
