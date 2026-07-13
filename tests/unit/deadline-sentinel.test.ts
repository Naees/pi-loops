import type { spawn as spawnType } from "node:child_process";
import { EventEmitter } from "node:events";
import { isAbsolute } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { launchWindowsDeadlineSentinel } from "../../src/worker/deadline-sentinel.js";

describe("Windows deadline sentinel", () => {
  it("launches an independent Node sentinel with bounded non-sensitive environment", () => {
    const calls: unknown[][] = [];
    const unref = vi.fn();
    const kill = vi.fn();
    const implementation = ((file: string, args: readonly string[], options: unknown) => {
      calls.push([file, args, options]);
      return Object.assign(new EventEmitter(), {
        exitCode: null,
        signalCode: null,
        unref,
        kill,
      });
    }) as unknown as typeof spawnType;

    const sentinel = launchWindowsDeadlineSentinel(123, Date.now() + 60_000, {
      environment: { SystemRoot: "C:\\Windows", SECRET_VALUE: "must-not-propagate" },
      spawn: implementation,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe(process.execPath);
    const args = calls[0]?.[1] as string[];
    expect(isAbsolute(args[0] ?? "")).toBe(true);
    expect(args.slice(1)).toEqual(["123", expect.stringMatching(/^\d+$/)]);
    expect(calls[0]?.[2]).toEqual(expect.objectContaining({
      detached: true,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
      env: { SystemRoot: "C:\\Windows" },
    }));
    expect(unref).toHaveBeenCalledOnce();

    sentinel.stop();
    sentinel.stop();
    expect(kill).toHaveBeenCalledOnce();
  });

  it("rejects invalid identities and deadlines before spawning", () => {
    for (const pid of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(() => launchWindowsDeadlineSentinel(pid, Date.now() + 60_000)).toThrow("positive safe PID");
    }
    expect(() => launchWindowsDeadlineSentinel(123, Date.now() - 1)).toThrow("future absolute deadline");
  });
});
