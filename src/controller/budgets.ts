import type { RunBudget } from "../shared/types.js";

export interface BudgetLedger {
  readonly cycles: number;
  readonly activeMs: number;
  readonly activeSinceMs?: number;
}

export type BudgetExhaustionReason = "cycles" | "active_time";

export const EMPTY_BUDGET_LEDGER: BudgetLedger = Object.freeze({
  cycles: 0,
  activeMs: 0,
});

export function startActiveTime(ledger: BudgetLedger, nowMs: number): BudgetLedger {
  if (ledger.activeSinceMs !== undefined) return ledger;
  return { ...ledger, activeSinceMs: nowMs };
}

export function pauseActiveTime(ledger: BudgetLedger, nowMs: number): BudgetLedger {
  if (ledger.activeSinceMs === undefined) return ledger;
  if (nowMs < ledger.activeSinceMs) throw new Error("Active-time clock moved backwards");

  return {
    cycles: ledger.cycles,
    activeMs: ledger.activeMs + (nowMs - ledger.activeSinceMs),
  };
}

export function incrementCycle(ledger: BudgetLedger): BudgetLedger {
  return { ...ledger, cycles: ledger.cycles + 1 };
}

export function currentActiveMs(ledger: BudgetLedger, nowMs: number): number {
  if (ledger.activeSinceMs === undefined) return ledger.activeMs;
  if (nowMs < ledger.activeSinceMs) throw new Error("Active-time clock moved backwards");
  return ledger.activeMs + (nowMs - ledger.activeSinceMs);
}

export function exhaustionReason(
  budget: RunBudget,
  ledger: BudgetLedger,
  nowMs: number,
): BudgetExhaustionReason | undefined {
  if (ledger.cycles >= budget.maxCycles) return "cycles";
  if (currentActiveMs(ledger, nowMs) >= budget.maxActiveMs) return "active_time";
  return undefined;
}
