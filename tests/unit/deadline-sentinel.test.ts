import type { spawn as spawnType } from "node:child_process";
import { EventEmitter } from "node:events";
import { isAbsolute, win32 } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  launchWindowsDeadlineSentinel,
  resolveWindowsDeadlineSentinelExecutable,
} from "../../src/worker/deadline-sentinel.js";

afterEach(() => {
  vi.useRealTimers();
});

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
      environment: { PROGRAMFILES: "C:\\Program Files", TEMP: "C:\\Temp", SECRET_VALUE: "fixture-value" },
      spawn: implementation,
    });
    await sentinel.ready;

    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe(win32.join("C:\\Program Files", "PowerShell", "7", "pwsh.exe"));
    const args = calls[0]?.[1] as string[];
    const scriptIndex = args.indexOf("-File") + 1;
    expect(isAbsolute(args[scriptIndex] ?? "")).toBe(true);
    expect(args).toEqual(expect.arrayContaining([
      "-TargetProcessId", "123",
      "-AbsoluteDeadlineMs", expect.stringMatching(/^\d+$/),
    ]));
    expect(calls[0]?.[2]).toEqual(expect.objectContaining({
      detached: false,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: expect.objectContaining({ PROGRAMFILES: "C:\\Program Files", TEMP: "C:\\Temp", SECRET_VALUE: "fixture-value" }),
    }));
    expect(childUnref).not.toHaveBeenCalled();
    expect(stdoutUnref).not.toHaveBeenCalled();
    expect(stderrUnref).not.toHaveBeenCalled();

    sentinel.stop();
    sentinel.stop();
    expect(kill).toHaveBeenCalledOnce();
  });

  it("fails closed immediately when the sentinel exits before reporting readiness", async () => {
    const stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
    const stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
    let child: EventEmitter | undefined;
    const kill = vi.fn();
    const onError = vi.fn();
    const implementation = (() => {
      child = Object.assign(new EventEmitter(), {
        exitCode: null,
        signalCode: null,
        stdout,
        stderr,
        kill,
      });
      return child;
    }) as unknown as typeof spawnType;
    const sentinel = launchWindowsDeadlineSentinel(123, Date.now() + 60_000, {
      environment: { ProgramFiles: "C:\\Program Files" },
      spawn: implementation,
      onError,
    });

    stderr.emit("data", "job assignment failed");
    child?.emit("exit", 0, null);

    await expect(sentinel.ready).rejects.toThrow("exited before becoming ready");
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      message: expect.stringContaining("job assignment failed"),
    }));
    expect(kill).not.toHaveBeenCalled();
  });

  it("reports a nonzero exit after readiness without confusing it with startup failure", async () => {
    const stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
    const stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
    let child: EventEmitter | undefined;
    const onError = vi.fn();
    const implementation = (() => {
      child = Object.assign(new EventEmitter(), {
        exitCode: null,
        signalCode: null,
        stdout,
        stderr,
        kill: vi.fn(),
      });
      queueMicrotask(() => stdout.emit("data", "PI_LOOPS_SENTINEL_READY\n"));
      return child;
    }) as unknown as typeof spawnType;
    const sentinel = launchWindowsDeadlineSentinel(123, Date.now() + 60_000, {
      environment: { ProgramFiles: "C:\\Program Files" },
      spawn: implementation,
      onError,
    });
    await sentinel.ready;

    child?.emit("exit", 7, null);

    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      message: expect.stringContaining('exited unsuccessfully: {"code":7'),
    }));
  });

  it("stops safely before readiness and ignores the resulting child exit", async () => {
    const stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
    const stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
    let child: EventEmitter | undefined;
    const kill = vi.fn();
    const onError = vi.fn();
    const implementation = (() => {
      child = Object.assign(new EventEmitter(), {
        exitCode: null,
        signalCode: null,
        stdout,
        stderr,
        kill,
      });
      return child;
    }) as unknown as typeof spawnType;
    const sentinel = launchWindowsDeadlineSentinel(123, Date.now() + 60_000, {
      environment: { ProgramFiles: "C:\\Program Files" },
      spawn: implementation,
      onError,
    });

    sentinel.stop();
    await expect(sentinel.ready).resolves.toBeUndefined();
    child?.emit("exit", 1, null);

    expect(kill).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  it("bounds readiness waiting and preserves startup diagnostics", async () => {
    vi.useFakeTimers();
    const stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
    const stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
    const kill = vi.fn();
    const onError = vi.fn();
    const implementation = (() => Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: null,
      stdout,
      stderr,
      kill,
    })) as unknown as typeof spawnType;
    const sentinel = launchWindowsDeadlineSentinel(123, Date.now() + 60_000, {
      environment: { ProgramFiles: "C:\\Program Files" },
      spawn: implementation,
      onError,
    });
    const readiness = expect(sentinel.ready).rejects.toThrow("did not become ready: startup diagnostics");
    stderr.emit("data", "startup diagnostics");

    await vi.advanceTimersByTimeAsync(20_000);

    await readiness;
    expect(onError).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledOnce();
  });

  it("resolves the preferred PowerShell 7 root case-insensitively", () => {
    expect(resolveWindowsDeadlineSentinelExecutable({
      programfiles: "C:\\Program Files",
      programw6432: "D:\\Program Files",
    })).toBe(win32.join("D:\\Program Files", "PowerShell", "7", "pwsh.exe"));
  });

  it("rejects invalid identities, deadlines, status paths, and system roots before spawning", () => {
    for (const pid of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(() => launchWindowsDeadlineSentinel(pid, Date.now() + 60_000)).toThrow("positive safe PID");
    }
    expect(() => launchWindowsDeadlineSentinel(123, Date.now() - 1)).toThrow("future absolute deadline");
    expect(() => launchWindowsDeadlineSentinel(123, Date.now() + 60_000, { statusPath: "relative.json" }))
      .toThrow("status path must be absolute");
    expect(() => launchWindowsDeadlineSentinel(123, Date.now() + 60_000, { environment: {} }))
      .toThrow("absolute Program Files root");
  });
});
