import type { spawn as spawnType } from "node:child_process";
import { EventEmitter } from "node:events";
import { isAbsolute, win32 } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { launchWindowsDeadlineSentinel } from "../../src/worker/deadline-sentinel.js";

describe("Windows deadline sentinel", () => {
  it("launches an independent job-object sentinel with an absolute executable and no shell", async () => {
    const calls: unknown[][] = [];
    const childUnref = vi.fn();
    const stdoutUnref = vi.fn();
    const stderrUnref = vi.fn();
    const kill = vi.fn();
    const stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn(), unref: stdoutUnref });
    const stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn(), unref: stderrUnref });
    const implementation = ((file: string, args: readonly string[], options: unknown) => {
      calls.push([file, args, options]);
      const child = Object.assign(new EventEmitter(), {
        exitCode: null,
        signalCode: null,
        stdout,
        stderr,
        unref: childUnref,
        kill,
      });
      queueMicrotask(() => stdout.emit("data", "PI_LOOPS_SENTINEL_READY\r\n"));
      return child;
    }) as unknown as typeof spawnType;

    const sentinel = launchWindowsDeadlineSentinel(123, Date.now() + 60_000, {
      environment: { SystemRoot: "C:\\Windows", TEMP: "C:\\Temp", SECRET_VALUE: "fixture-value" },
      spawn: implementation,
    });
    await sentinel.ready;

    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe(win32.join("C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
    const args = calls[0]?.[1] as string[];
    const scriptIndex = args.indexOf("-File") + 1;
    expect(isAbsolute(args[scriptIndex] ?? "")).toBe(true);
    expect(args).toEqual(expect.arrayContaining([
      "-TargetProcessId", "123",
      "-AbsoluteDeadlineMs", expect.stringMatching(/^\d+$/),
    ]));
    expect(calls[0]?.[2]).toEqual(expect.objectContaining({
      detached: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: expect.objectContaining({ SystemRoot: "C:\\Windows", TEMP: "C:\\Temp", SECRET_VALUE: "fixture-value" }),
    }));
    expect(childUnref).toHaveBeenCalledOnce();
    expect(stdoutUnref).toHaveBeenCalledOnce();
    expect(stderrUnref).toHaveBeenCalledOnce();

    sentinel.stop();
    sentinel.stop();
    expect(kill).toHaveBeenCalledOnce();
  });

  it("rejects invalid identities, deadlines, and system roots before spawning", () => {
    for (const pid of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(() => launchWindowsDeadlineSentinel(pid, Date.now() + 60_000)).toThrow("positive safe PID");
    }
    expect(() => launchWindowsDeadlineSentinel(123, Date.now() - 1)).toThrow("future absolute deadline");
    expect(() => launchWindowsDeadlineSentinel(123, Date.now() + 60_000, { environment: {} }))
      .toThrow("absolute system root");
  });
});
