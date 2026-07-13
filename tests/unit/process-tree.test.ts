import type { execFile as execFileType } from "node:child_process";
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
  });

  it("uses the absolute Windows system taskkill without a shell", async () => {
    const calls: unknown[][] = [];
    const implementation = ((file: string, args: readonly string[], options: unknown, callback: (error: Error | null) => void) => {
      calls.push([file, args, options]);
      callback(null);
      return {};
    }) as unknown as typeof execFileType;

    await terminateProcessTree(789, {
      platform: "win32",
      force: true,
      environment: { SystemRoot: "/windows" },
      execFile: implementation,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe("/windows/System32/taskkill.exe");
    expect(calls[0]?.[1]).toEqual(["/T", "/PID", "789", "/F"]);
    expect(calls[0]?.[2]).toEqual(expect.objectContaining({ windowsHide: true, timeout: 10_000 }));
  });

  it("rejects invalid PIDs and untrusted Windows system roots", async () => {
    for (const pid of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
      await expect(terminateProcessTree(pid)).rejects.toThrow("positive safe PID");
    }
    expect(() => resolveWindowsTaskkill({ SystemRoot: "relative" })).toThrow("absolute system root");
    expect(() => resolveWindowsTaskkill({})).toThrow("absolute system root");
  });
});
