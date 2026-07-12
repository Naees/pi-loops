import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHILD_DEADLINE_ENV, parseChildDeadline, registerWorkerWatchdog } from "../../src/worker/watchdog.js";

afterEach(() => {
  vi.useRealTimers();
});

function harness() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const pi = {
    on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => handlers.set(event, handler)),
  } as unknown as ExtensionAPI;
  const context = {
    abort: vi.fn(),
    shutdown: vi.fn(),
    ui: { notify: vi.fn() },
  } as unknown as ExtensionContext;
  return { pi, handlers, context };
}

describe("child watchdog", () => {
  it("strictly parses a future absolute deadline", () => {
    expect(parseChildDeadline("2000", 1000)).toBe(2000);
    expect(parseChildDeadline("1000", 1000)).toBeUndefined();
    expect(parseChildDeadline("1e9", 1000)).toBeUndefined();
    expect(parseChildDeadline(undefined, 1000)).toBeUndefined();
  });

  it("fails closed when the deadline is missing", async () => {
    const { pi, handlers, context } = harness();
    const terminateSelf = vi.fn();
    registerWorkerWatchdog(pi, { environment: {}, now: () => 1000, terminateSelf, gracefulShutdownMs: 10 });

    await handlers.get("session_start")?.({}, context);

    expect(context.abort).toHaveBeenCalledOnce();
    expect(context.shutdown).toHaveBeenCalledOnce();
  });

  it("aborts and shuts down when the deadline expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const { pi, handlers, context } = harness();
    const terminateSelf = vi.fn();
    registerWorkerWatchdog(pi, {
      environment: { [CHILD_DEADLINE_ENV]: "2000" },
      now: Date.now,
      terminateSelf,
      gracefulShutdownMs: 100,
    });

    await handlers.get("session_start")?.({}, context);
    await vi.advanceTimersByTimeAsync(999);
    expect(context.abort).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(context.abort).toHaveBeenCalledOnce();
    expect(context.shutdown).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(100);
    expect(terminateSelf).toHaveBeenCalledOnce();
  });
});
