import { describe, expect, it } from "vitest";
import { EMPTY_PROGRESS_TRACKER, createFailureSignature, isStalled, recordFailure } from "../../src/controller/no-progress.js";

describe("no-progress detection", () => {
  it("normalizes equivalent failure evidence", () => {
    const first = createFailureSignature(["Tests still fail"], [" 2 FAILED   10 passed "]);
    const second = createFailureSignature([" tests STILL fail "], ["2 failed 10 PASSED"]);
    expect(first).toBe(second);
  });

  it("counts consecutive equivalent failures and resets on change", () => {
    const signatureA = createFailureSignature(["a"], []);
    const signatureB = createFailureSignature(["b"], []);
    const once = recordFailure(EMPTY_PROGRESS_TRACKER, signatureA);
    const twice = recordFailure(once, signatureA);
    const changed = recordFailure(twice, signatureB);

    expect(isStalled(twice, 2)).toBe(true);
    expect(changed.equivalentFailures).toBe(1);
    expect(isStalled(changed, 2)).toBe(false);
  });

  it("rejects invalid stall thresholds", () => {
    for (const threshold of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(() => isStalled(EMPTY_PROGRESS_TRACKER, threshold)).toThrow("positive safe integer");
    }
  });
});
