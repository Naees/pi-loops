import { EventEmitter } from "node:events";
import type { FSWatcher } from "node:fs";
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProjectId } from "../../src/shared/ids.js";
import type { TriggerRecord } from "../../src/shared/types.js";
import { FilesystemTriggerManager, resolveFilesystemTarget } from "../../src/triggers/filesystem.js";

const temporary: string[] = [];
afterEach(async () => Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

async function project() {
  const root = await mkdtemp(join(tmpdir(), "pi-loops-filesystem-trigger-"));
  temporary.push(root);
  const projectRoot = join(root, "project");
  await mkdir(join(projectRoot, "src"), { recursive: true });
  await mkdir(join(projectRoot, ".git"));
  await writeFile(join(projectRoot, "src", "input.txt"), "initial\n");
  return { root, projectRoot: await realpath(projectRoot) };
}

function trigger(projectRoot: string): TriggerRecord {
  return {
    schemaVersion: 1,
    triggerId: "trigger_1234abcd",
    projectId: createProjectId(projectRoot),
    projectRoot,
    state: "enabled",
    goal: "regenerate output",
    constraints: [],
    verifierCommands: [],
    budget: { maxActiveMs: 60_000, maxCycles: 3, stallThreshold: 2 },
    source: { kind: "filesystem", relativePath: "src", debounceMs: 100 },
    createdAt: "2026-07-12T12:00:00.000Z",
    updatedAt: "2026-07-12T12:00:00.000Z",
  };
}

describe("filesystem triggers", () => {
  it("canonicalizes project-contained paths and rejects escaping symlinks and Git metadata", async () => {
    const { root, projectRoot } = await project();
    await expect(resolveFilesystemTarget(projectRoot, "@src")).resolves.toEqual({
      absolutePath: await realpath(join(projectRoot, "src")),
      relativePath: "src",
    });
    const outside = join(root, "outside");
    await mkdir(outside);
    await symlink(outside, join(projectRoot, "outside-link"), "dir");
    await expect(resolveFilesystemTarget(projectRoot, "outside-link")).rejects.toThrow("escapes its project");
    await expect(resolveFilesystemTarget(projectRoot, ".git")).rejects.toThrow("cannot watch Git metadata");
    for (const invalid of ["", "@", "\0bad", "x".repeat(16 * 1024 + 1)]) {
      await expect(resolveFilesystemTarget(projectRoot, invalid)).rejects.toThrow("invalid");
    }
  });

  it("debounces a filesystem event storm into one trigger", async () => {
    const { projectRoot } = await project();
    const onTrigger = vi.fn(async () => undefined);
    let listener: ((eventType: string, filename: string | Buffer | null) => void) | undefined;
    const watcher = Object.assign(new EventEmitter(), { close: vi.fn(), unref: vi.fn() }) as unknown as FSWatcher;
    const manager = new FilesystemTriggerManager({
      onTrigger,
      onError: vi.fn(),
      watch: (_path, _options, callback) => {
        listener = callback;
        return watcher;
      },
    });
    await manager.upsert(trigger(projectRoot));
    const input = join(projectRoot, "src", "input.txt");
    for (let index = 0; index < 20; index += 1) {
      await writeFile(input, `value ${index}\n`);
      listener?.("change", "input.txt");
    }
    await vi.waitFor(() => expect(onTrigger).toHaveBeenCalledOnce(), { timeout: 2_000 });
    manager.shutdown();
  });

  it("fails closed if the watched inode moves outside the project", async () => {
    const { root, projectRoot } = await project();
    const onTrigger = vi.fn(async () => undefined);
    const onError = vi.fn();
    let listener: ((eventType: string, filename: string | Buffer | null) => void) | undefined;
    const watcher = Object.assign(new EventEmitter(), { close: vi.fn(), unref: vi.fn() }) as unknown as FSWatcher;
    const manager = new FilesystemTriggerManager({
      onTrigger,
      onError,
      watch: (_path, _options, callback) => {
        listener = callback;
        return watcher;
      },
    });
    await manager.upsert(trigger(projectRoot));
    const moved = join(root, "moved-src");
    await rename(join(projectRoot, "src"), moved);
    await writeFile(join(moved, "input.txt"), "outside change\n");
    listener?.("rename", "input.txt");
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onTrigger).not.toHaveBeenCalled();
    expect(watcher.close).toHaveBeenCalledOnce();
    manager.shutdown();
  });

  it("revalidates and re-arms a safe same-path atomic replacement", async () => {
    const { root, projectRoot } = await project();
    const onTrigger = vi.fn(async () => undefined);
    const listeners: ((eventType: string, filename: string | Buffer | null) => void)[] = [];
    const watchers: FSWatcher[] = [];
    const manager = new FilesystemTriggerManager({
      onTrigger,
      onError: vi.fn(),
      watch: (_path, _options, callback) => {
        listeners.push(callback);
        const watcher = Object.assign(new EventEmitter(), { close: vi.fn(), unref: vi.fn() }) as unknown as FSWatcher;
        watchers.push(watcher);
        return watcher;
      },
    });
    await manager.upsert(trigger(projectRoot));

    const replaced = join(root, "replaced-src");
    await rename(join(projectRoot, "src"), replaced);
    await mkdir(join(projectRoot, "src"));
    await writeFile(join(projectRoot, "src", "input.txt"), "replacement\n");
    listeners[0]?.("rename", "input.txt");

    await vi.waitFor(() => expect(onTrigger).toHaveBeenCalledOnce());
    expect(listeners).toHaveLength(2);
    expect(watchers[0]?.close).toHaveBeenCalledOnce();
    listeners[1]?.("change", "input.txt");
    await vi.waitFor(() => expect(onTrigger).toHaveBeenCalledTimes(2));
    manager.shutdown();
  });

  it("fails closed on unattributed recursive events", async () => {
    const { projectRoot } = await project();
    const onTrigger = vi.fn(async () => undefined);
    let listener: ((eventType: string, filename: string | Buffer | null) => void) | undefined;
    const watcher = Object.assign(new EventEmitter(), { close: vi.fn(), unref: vi.fn() }) as unknown as FSWatcher;
    const manager = new FilesystemTriggerManager({
      onTrigger,
      onError: vi.fn(),
      watch: (_path, _options, callback) => {
        listener = callback;
        return watcher;
      },
    });
    await manager.upsert(trigger(projectRoot));
    listener?.("change", null);
    listener?.("change", ".git/config");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(onTrigger).not.toHaveBeenCalled();
    listener?.("change", "input.txt");
    await vi.waitFor(() => expect(onTrigger).toHaveBeenCalledOnce());
    manager.shutdown();
  });

  it("cancels pending debounce work during shutdown", async () => {
    const { projectRoot } = await project();
    const onTrigger = vi.fn(async () => undefined);
    let listener: ((eventType: string, filename: string | Buffer | null) => void) | undefined;
    const watcher = Object.assign(new EventEmitter(), { close: vi.fn(), unref: vi.fn() }) as unknown as FSWatcher;
    const manager = new FilesystemTriggerManager({
      onTrigger,
      onError: vi.fn(),
      watch: (_path, _options, callback) => {
        listener = callback;
        return watcher;
      },
    });
    await manager.upsert(trigger(projectRoot));
    await writeFile(join(projectRoot, "src", "input.txt"), "changed\n");
    listener?.("change", "input.txt");
    await new Promise((resolve) => setTimeout(resolve, 20));
    manager.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(onTrigger).not.toHaveBeenCalled();
  });
});
