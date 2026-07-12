import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { CurrentModelEvaluator, EvaluatorUnavailableError } from "../../src/evidence/evaluator.js";

describe("current-model evaluator", () => {
  it("rejects deterministic failures before consulting a model", async () => {
    const context = {
      model: undefined,
      modelRegistry: {},
    } as unknown as Pick<ExtensionContext, "model" | "modelRegistry">;

    await expect(new CurrentModelEvaluator(context).evaluate({
      goal: "tests pass",
      constraints: [],
      workerSummary: "tests still fail",
      verifierEvidence: [{ criterion: "npm test exits 0", passed: false, summary: "2 failed" }],
    })).resolves.toEqual({
      complete: false,
      needsUser: false,
      reason: "Required deterministic verification is failing or missing.",
      failedCriteria: ["npm test exits 0"],
      feedback: "npm test exits 0: 2 failed",
    });
  });

  it("fails clearly when no model is selected", async () => {
    const context = {
      model: undefined,
      modelRegistry: {},
    } as unknown as Pick<ExtensionContext, "model" | "modelRegistry">;

    await expect(new CurrentModelEvaluator(context).evaluate({
      goal: "done",
      constraints: [],
      workerSummary: "",
      verifierEvidence: [],
    })).rejects.toBeInstanceOf(EvaluatorUnavailableError);
  });
});
