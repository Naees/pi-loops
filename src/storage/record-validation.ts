import { COMPLETION_LIMITS } from "../contracts/completion-limits.js";
import { isRunBudget } from "../shared/validation.js";

export function isCanonicalIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

export function isBoundedNonEmptyStringArray(
  value: unknown,
  maximumItems: number,
  maximumItemBytes: number,
): value is string[] {
  return Array.isArray(value) && value.length <= maximumItems && value.every((item) =>
    typeof item === "string" && item.trim().length > 0 && Buffer.byteLength(item, "utf8") <= maximumItemBytes);
}

export function hasValidStoredCompletionDefinition(value: Record<string, unknown>): boolean {
  return typeof value.goal === "string" &&
    value.goal.trim().length > 0 &&
    Buffer.byteLength(value.goal, "utf8") <= COMPLETION_LIMITS.goalBytes &&
    isBoundedNonEmptyStringArray(value.constraints, COMPLETION_LIMITS.constraintCount, COMPLETION_LIMITS.itemBytes) &&
    isBoundedNonEmptyStringArray(value.verifierCommands, COMPLETION_LIMITS.verifierCount, COMPLETION_LIMITS.itemBytes) &&
    isRunBudget(value.budget);
}
