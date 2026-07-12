import { describe, expect, it } from "vitest";
import { selectRetentionEvictions } from "../../src/storage/retention.js";

describe("run retention", () => {
  it("evicts only least-recently-used eligible records beyond the limit", () => {
    const candidates = Array.from({ length: 53 }, (_, index) => ({
      runId: `run_${index.toString(16).padStart(8, "0")}`,
      lastUsedMs: index,
      eligible: index !== 0,
    }));

    expect(selectRetentionEvictions(candidates, 50)).toEqual([
      "run_00000001",
      "run_00000002",
    ]);
  });

  it("does not count ineligible active or unresolved runs toward the cap", () => {
    expect(
      selectRetentionEvictions(
        [
          { runId: "run_active", lastUsedMs: 1, eligible: false },
          { runId: "run_done", lastUsedMs: 0, eligible: true },
        ],
        1,
      ),
    ).toEqual([]);
  });
});
