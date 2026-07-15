import { mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProjectId } from "../../src/shared/ids.js";
import type { TriggerRecord } from "../../src/shared/types.js";
import { FilesystemTriggerManager } from "../../src/triggers/filesystem.js";

const temporary: string[] = [];
afterEach(async () => Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

function fileTrigger(projectRoot: string): TriggerRecord {
  const at = new Date().toISOString();
  return {
    schemaVersion: 1,
    triggerId: "trigger_1234abcd",
    projectId: createProjectId(projectRoot),
    projectRoot,
    state: "enabled",
    goal: "observe atomic file replacement",
    constraints: [],
    verifierCommands: [],
    budget: { maxActiveMs: 60_000, maxCycles: 1, stallThreshold: 2 },
    source: { kind: "filesystem", relativePath: "watched.txt", debounceMs: 100 },
    createdAt: at,
    updatedAt: at,
  };
}

describe.skipIf(process.env.PI_LOOPS_NATIVE_WATCH_QUALIFICATION !== "1")("native filesystem trigger qualification", () => {
  it("continues observing a file after an atomic same-path replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-loops-native-filesystem-trigger-"));
    temporary.push(root);
    const projectRoot = await realpath(root);
    const watched = join(projectRoot, "watched.txt");
    await writeFile(watched, "before\n");
    let deliveries = 0;
    const errors: unknown[] = [];
    const manager = new FilesystemTriggerManager({
      onTrigger: async () => { deliveries += 1; },
      onError: (_triggerId, error) => { errors.push(error); },
    });

    try {
      await manager.upsert(fileTrigger(projectRoot));
      const replacement = join(projectRoot, "replacement.txt");
      await writeFile(replacement, "replacement\n");
      await rename(replacement, watched);
      await vi.waitFor(() => {
        if (errors[0]) throw errors[0];
        expect(deliveries).toBeGreaterThanOrEqual(1);
      }, { timeout: 5_000 });
      const afterReplacement = deliveries;

      await writeFile(watched, "after re-arm\n");
      await vi.waitFor(() => {
        if (errors[0]) throw errors[0];
        expect(deliveries).toBeGreaterThan(afterReplacement);
      }, { timeout: 5_000 });
    } finally {
      manager.shutdown();
    }
  }, 15_000);
});
