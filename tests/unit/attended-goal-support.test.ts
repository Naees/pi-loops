import { afterEach, describe, expect, it, vi } from "vitest";
import { abortableDelay, retentionEligible } from "../../src/controller/attended-goal-support.js";
import type { RunRecord } from "../../src/shared/types.js";

function run(overrides: Partial<RunRecord>): RunRecord {
  return {
    state: "completed",
    ...overrides,
  } as RunRecord;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("attended goal support", () => {
  it("settles or aborts bounded retry delays deterministically", async () => {
    vi.useFakeTimers();
    const completed = abortableDelay(100, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(100);
    await expect(completed).resolves.toBeUndefined();

    const abort = new AbortController();
    const interrupted = abortableDelay(1_000, abort.signal, "Retry cancelled");
    abort.abort();
    await expect(interrupted).rejects.toMatchObject({ name: "AbortError", message: "Retry cancelled" });

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(abortableDelay(1_000, alreadyAborted.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it.each([
    ["completed", {}, true],
    ["cancelled", { state: "cancelled" }, true],
    ["permanent failure", { state: "failed", failureRecoverable: false }, true],
    ["recoverable failure", { state: "failed", failureRecoverable: true }, false],
    ["interrupted", { state: "interrupted" }, false],
    ["active", { state: "running" }, false],
    ["retained worktree", { worker: { worktreeRetained: true } as RunRecord["worker"] }, false],
    ["resolved worktree", { worker: { worktreeRetained: false } as RunRecord["worker"] }, true],
  ])("classifies %s retention eligibility", (_label, overrides, expected) => {
    expect(retentionEligible(run(overrides as Partial<RunRecord>))).toBe(expected);
  });
});
