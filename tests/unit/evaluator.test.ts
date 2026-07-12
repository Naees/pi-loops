import { describe, expect, it } from "vitest";
import { InvalidEvaluatorResponseError, parseEvaluationDecision } from "../../src/evidence/evaluator.js";

describe("evaluator decisions", () => {
  it("parses a strict completion decision", () => {
    expect(
      parseEvaluationDecision(
        JSON.stringify({
          complete: false,
          needsUser: false,
          reason: "Tests fail",
          failedCriteria: ["npm test exits 0"],
          feedback: "Fix the remaining failure",
        }),
      ),
    ).toEqual({
      complete: false,
      needsUser: false,
      reason: "Tests fail",
      failedCriteria: ["npm test exits 0"],
      feedback: "Fix the remaining failure",
    });
  });

  it("rejects oversized model-controlled output", () => {
    expect(() => parseEvaluationDecision("x".repeat(64 * 1024 + 1))).toThrow("exceeds 65536 bytes");
    expect(() =>
      parseEvaluationDecision(
        JSON.stringify({
          complete: false,
          needsUser: false,
          reason: "incomplete",
          failedCriteria: ["x".repeat(4 * 1024 + 1)],
          feedback: null,
        }),
      ),
    ).toThrow("invalid shape");
  });

  it("rejects markdown, unknown fields, and contradictory outcomes", () => {
    expect(() => parseEvaluationDecision("```json\n{}\n```" )).toThrow(InvalidEvaluatorResponseError);
    expect(() =>
      parseEvaluationDecision(
        JSON.stringify({ complete: true, needsUser: false, reason: "done", failedCriteria: [], feedback: null, extra: true }),
      ),
    ).toThrow("Unknown evaluator field");
    expect(() =>
      parseEvaluationDecision(
        JSON.stringify({ complete: true, needsUser: true, reason: "done", failedCriteria: [], feedback: null }),
      ),
    ).toThrow("cannot also require");
    expect(() =>
      parseEvaluationDecision(
        JSON.stringify({ complete: true, needsUser: false, reason: "done", failedCriteria: ["tests"], feedback: null }),
      ),
    ).toThrow("cannot contain failed criteria");
  });
});
