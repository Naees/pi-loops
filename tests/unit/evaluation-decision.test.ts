import { describe, expect, it } from "vitest";
import {
  hasCoherentEvaluationDecision,
  hasEvaluationDecisionShape,
  isEvaluationDecision,
  unknownEvaluationDecisionKeys,
} from "../../src/evidence/evaluation-decision.js";

const valid = {
  complete: false,
  needsUser: false,
  reason: "More work is required",
  failedCriteria: ["tests"],
  feedback: "Fix the failure",
};

describe("evaluation decision validation", () => {
  it("accepts the exact shared provider and storage shape", () => {
    expect(unknownEvaluationDecisionKeys(valid)).toEqual([]);
    expect(hasEvaluationDecisionShape(valid)).toBe(true);
    expect(hasCoherentEvaluationDecision(valid)).toBe(true);
    expect(isEvaluationDecision(valid)).toBe(true);
  });

  it("enforces field allowlisting and UTF-8 byte boundaries", () => {
    expect(unknownEvaluationDecisionKeys({ ...valid, extra: true })).toEqual(["extra"]);
    expect(hasEvaluationDecisionShape({ ...valid, extra: true })).toBe(false);

    expect(hasEvaluationDecisionShape({ ...valid, reason: "x".repeat(8 * 1024) })).toBe(true);
    expect(hasEvaluationDecisionShape({ ...valid, reason: "界".repeat(2_731) })).toBe(false);
    expect(hasEvaluationDecisionShape({ ...valid, failedCriteria: ["x".repeat(4 * 1024)] })).toBe(true);
    expect(hasEvaluationDecisionShape({ ...valid, failedCriteria: ["界".repeat(1_366)] })).toBe(false);
    expect(hasEvaluationDecisionShape({ ...valid, feedback: "x".repeat(16 * 1024) })).toBe(true);
    expect(hasEvaluationDecisionShape({ ...valid, feedback: "界".repeat(5_462) })).toBe(false);
  });

  it("bounds failed criteria and rejects contradictory outcomes", () => {
    expect(hasEvaluationDecisionShape({ ...valid, failedCriteria: Array.from({ length: 50 }, () => "criterion") })).toBe(true);
    expect(hasEvaluationDecisionShape({ ...valid, failedCriteria: Array.from({ length: 51 }, () => "criterion") })).toBe(false);

    const needsUserAfterCompletion = { ...valid, complete: true, needsUser: true, failedCriteria: [] };
    const failuresAfterCompletion = { ...valid, complete: true, needsUser: false };
    expect(hasEvaluationDecisionShape(needsUserAfterCompletion)).toBe(true);
    expect(hasCoherentEvaluationDecision(needsUserAfterCompletion)).toBe(false);
    expect(isEvaluationDecision(needsUserAfterCompletion)).toBe(false);
    expect(hasEvaluationDecisionShape(failuresAfterCompletion)).toBe(true);
    expect(hasCoherentEvaluationDecision(failuresAfterCompletion)).toBe(false);
    expect(isEvaluationDecision(failuresAfterCompletion)).toBe(false);
  });

  it.each([
    null,
    [],
    {},
    { ...valid, complete: "false" },
    { ...valid, needsUser: 0 },
    { ...valid, reason: " " },
    { ...valid, failedCriteria: [null] },
    { ...valid, feedback: undefined },
  ])("rejects malformed shape %#", (value) => {
    expect(hasEvaluationDecisionShape(value)).toBe(false);
    expect(isEvaluationDecision(value)).toBe(false);
  });
});
