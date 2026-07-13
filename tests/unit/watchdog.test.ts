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
    for (const value of [undefined, "", " 2000", "+2000", "-2000", "2000.5", "1e9", "NaN", "Infinity", String(Number.MAX_SAFE_INTEGER + 1)]) {
      expect(parseChildDeadline(value, 1000), String(value)).toBeUndefined();
    }
    expect(parseChildDeadline("1000", 1000)).toBeUndefined();
    expect(parseChildDeadline("999", 1000)).toBeUndefined();
  });

  it("rejects invalid graceful shutdown limits", () => {
    const { pi } = harness();
    for (const gracefulShutdownMs of [-1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(() => registerWorkerWatchdog(pi, { gracefulShutdownMs })).toThrow("non-negative safe integer");
    }
  });

  it("fails closed when the deadline is missing", async () => {
    const { pi, handlers, context } = harness();
    const terminateSelf = vi.fn();
    registerWorkerWatchdog(pi, { environment: {}, now: () => 1000, terminateSelf, gracefulShutdownMs: 10 });

    await handlers.get("session_start")?.({}, context);

    expect(context.abort).toHaveBeenCalledOnce();
    expect(context.shutdown).toHaveBeenCalledOnce();
  });

  it("forces the Windows process tree while the child still exists", async () => {
    const { pi, handlers, context } = harness();
    const terminateSelf = vi.fn();
    registerWorkerWatchdog(pi, {
      environment: {},
      now: () => 1000,
      terminateSelf,
      gracefulShutdownMs: 100,
      platform: "win32",
    });

    await handlers.get("session_start")?.({}, context);

    expect(context.abort).toHaveBeenCalledOnce();
    expect(context.shutdown).toHaveBeenCalledOnce();
    expect(terminateSelf).toHaveBeenCalledOnce();
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

    await handlers.get("session_shutdown")?.({}, context);
    await vi.advanceTimersByTimeAsync(100);
    expect(terminateSelf).toHaveBeenCalledOnce();
  });
});
