import type { RunBudget } from "./types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

export function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function isRunBudget(value: unknown): value is RunBudget {
  return isRecord(value) &&
    hasOnlyKeys(value, ["maxActiveMs", "maxCycles", "stallThreshold"]) &&
    isPositiveSafeInteger(value.maxActiveMs) &&
    isPositiveSafeInteger(value.maxCycles) &&
    isPositiveSafeInteger(value.stallThreshold);
}
