import { COMPLETION_LIMITS } from "../contracts/completion-limits.js";
import type { StoredEvaluationDecision } from "../shared/types.js";
import { hasOnlyKeys, isRecord, isStringArray } from "../shared/validation.js";

const EVALUATION_DECISION_KEYS = ["complete", "needsUser", "reason", "failedCriteria", "feedback"] as const;

export function unknownEvaluationDecisionKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value).filter((key) => !EVALUATION_DECISION_KEYS.includes(key as (typeof EVALUATION_DECISION_KEYS)[number]));
}

export function hasEvaluationDecisionShape(value: unknown): value is StoredEvaluationDecision {
  return isRecord(value) &&
    hasOnlyKeys(value, EVALUATION_DECISION_KEYS) &&
    typeof value.complete === "boolean" &&
    typeof value.needsUser === "boolean" &&
    typeof value.reason === "string" &&
    value.reason.trim().length > 0 &&
    Buffer.byteLength(value.reason, "utf8") <= 8 * 1024 &&
    isStringArray(value.failedCriteria) &&
    value.failedCriteria.length <= COMPLETION_LIMITS.failedCriterionCount &&
    value.failedCriteria.every((criterion) => Buffer.byteLength(criterion, "utf8") <= COMPLETION_LIMITS.failedCriterionBytes) &&
    (typeof value.feedback === "string" || value.feedback === null) &&
    (typeof value.feedback !== "string" || Buffer.byteLength(value.feedback, "utf8") <= 16 * 1024);
}

export function hasCoherentEvaluationDecision(value: StoredEvaluationDecision): boolean {
  return !(value.complete && value.needsUser) && !(value.complete && value.failedCriteria.length > 0);
}

export function isEvaluationDecision(value: unknown): value is StoredEvaluationDecision {
  return hasEvaluationDecisionShape(value) && hasCoherentEvaluationDecision(value);
}
