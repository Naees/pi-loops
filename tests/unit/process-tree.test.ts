import type { spawn as spawnType } from "node:child_process";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveWindowsTaskkill, terminateProcessTree } from "../../src/worker/process-tree.js";

describe("process-tree termination", () => {
  it("signals a detached POSIX process group and falls back to its direct child", async () => {
    const groupKill = vi.fn();
    await terminateProcessTree(123, { platform: "linux", kill: groupKill as typeof process.kill });
    expect(groupKill).toHaveBeenCalledWith(-123, "SIGTERM");

    const fallbackKill = vi.fn((pid: number) => {
      if (pid < 0) throw Object.assign(new Error("no group"), { code: "ESRCH" });
      return true;
    });
    await terminateProcessTree(456, { platform: "darwin", force: true, kill: fallbackKill as typeof process.kill });
    expect(fallbackKill.mock.calls).toEqual([[-456, "SIGKILL"], [456, "SIGKILL"]]);

    const deniedKill = vi.fn(() => {
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    });
    await expect(terminateProcessTree(457, { platform: "linux", kill: deniedKill as typeof process.kill }))
      .rejects.toMatchObject({ code: "EPERM" });
    expect(deniedKill).toHaveBeenCalledOnce();

    const alreadyGone = vi.fn((_pid: number) => {
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    });
    await expect(terminateProcessTree(458, { platform: "linux", kill: alreadyGone as typeof process.kill }))
      .resolves.toBeUndefined();
    expect(alreadyGone.mock.calls.map(([pid]) => pid)).toEqual([-458, 458]);
  });

  it("uses the absolute Windows system taskkill without a shell", async () => {
    const calls: unknown[][] = [];
    const implementation = ((file: string, args: readonly string[], options: unknown) => {
      calls.push([file, args, options]);
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    }) as unknown as typeof spawnType;

    await terminateProcessTree(789, {
      platform: "win32",
      force: true,
      environment: { SystemRoot: "/windows" },
      spawn: implementation,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe(join("/windows", "System32", "taskkill.exe"));
    expect(calls[0]?.[1]).toEqual(["/T", "/PID", "789", "/F"]);
    expect(calls[0]?.[2]).toEqual(expect.objectContaining({ detached: true, windowsHide: true, timeout: 10_000 }));
  });

  it("omits forced termination unless requested and surfaces taskkill failures", async () => {
    const successfulCalls: unknown[][] = [];
    const successful = ((file: string, args: readonly string[], options: unknown) => {
      successfulCalls.push([file, args, options]);
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    }) as unknown as typeof spawnType;
    await terminateProcessTree(790, {
      platform: "win32",
      environment: { WINDIR: "/windows" },
      spawn: successful,
    });
    expect(successfulCalls[0]?.[1]).toEqual(["/T", "/PID", "790"]);

    const spawnFailure = ((..._args: unknown[]) => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("error", new Error("spawn denied")));
      return child;
    }) as unknown as typeof spawnType;
    await expect(terminateProcessTree(791, {
      platform: "win32",
      environment: { SystemRoot: "/windows" },
      spawn: spawnFailure,
    })).rejects.toThrow("spawn denied");

    const exitFailure = ((..._args: unknown[]) => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 5, null));
      return child;
    }) as unknown as typeof spawnType;
    await expect(terminateProcessTree(792, {
      platform: "win32",
      environment: { SystemRoot: "/windows" },
      spawn: exitFailure,
    })).rejects.toThrow('taskkill failed: {"code":5,"signal":null}');
  });

  it("rejects invalid PIDs and untrusted Windows system roots", async () => {
    for (const pid of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
      await expect(terminateProcessTree(pid)).rejects.toThrow("positive safe PID");
    }
    expect(() => resolveWindowsTaskkill({ SystemRoot: "relative" })).toThrow("absolute system root");
    expect(() => resolveWindowsTaskkill({})).toThrow("absolute system root");
  });
});
