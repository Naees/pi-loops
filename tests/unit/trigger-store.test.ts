import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProjectId } from "../../src/shared/ids.js";
import type { TriggerRecord } from "../../src/shared/types.js";
import { acquireWriterLease, releaseWriterLease, type WriterLease } from "../../src/storage/lease.js";
import { TriggerStore, triggerClaimLeasePath, triggerLeasePath } from "../../src/storage/trigger-store.js";

const temporary: string[] = [];
const leases: WriterLease[] = [];
afterEach(async () => {
  await Promise.all(leases.splice(0).map((lease) => releaseWriterLease(lease).catch(() => undefined)));
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function harness() {
  const dataRoot = await mkdtemp(join(tmpdir(), "pi-loops-trigger-store-"));
  const projectDirectory = await mkdtemp(join(tmpdir(), "pi-loops-trigger-project-"));
  temporary.push(dataRoot, projectDirectory);
  const projectRoot = await realpath(projectDirectory);
  const projectId = createProjectId(projectRoot);
  const lease = await acquireWriterLease(triggerLeasePath(dataRoot, projectId), 5_000);
  leases.push(lease);
  return { dataRoot, projectRoot, projectId, store: new TriggerStore(dataRoot, projectId, lease) };
}

function trigger(projectRoot: string, projectId: string, index = 1): TriggerRecord {
  const at = "2026-07-12T12:00:00.000Z";
  return {
    schemaVersion: 1,
    triggerId: `trigger_${index.toString(16).padStart(8, "0")}`,
    projectId,
    projectRoot,
    state: "enabled",
    goal: `goal ${index}`,
    constraints: [],
    verifierCommands: [],
    budget: { maxActiveMs: 60_000, maxCycles: 3, stallThreshold: 2 },
    source: { kind: "filesystem", relativePath: "src", debounceMs: 1_000 },
    createdAt: at,
    updatedAt: at,
  };
}

describe("trigger store", () => {
  it("saves, lists, loads, and deletes strict trigger records", async () => {
    const { store, projectRoot, projectId } = await harness();
    await store.save(trigger(projectRoot, projectId, 2));
    await store.save(trigger(projectRoot, projectId, 1));
    expect((await store.list()).map((item) => item.triggerId)).toEqual(["trigger_00000001", "trigger_00000002"]);
    expect((await store.load("trigger_00000001"))?.goal).toBe("goal 1");
    await store.delete("trigger_00000001");
    expect(await store.load("trigger_00000001")).toBeUndefined();
  });

  it("persists bounded watcher failures separately from frozen trigger records", async () => {
    const { store, projectRoot, projectId } = await harness();
    const record = trigger(projectRoot, projectId);
    await store.save(record);
    await store.saveFailure({
      schemaVersion: 1,
      triggerId: record.triggerId,
      reason: "native watcher failed",
      failedAt: "2026-07-12T12:01:00.000Z",
    });
    await expect(store.loadFailure(record.triggerId)).resolves.toEqual(expect.objectContaining({ reason: "native watcher failed" }));
    await store.clearFailure(record.triggerId);
    await expect(store.loadFailure(record.triggerId)).resolves.toBeUndefined();
    await store.saveFailure({
      schemaVersion: 1,
      triggerId: record.triggerId,
      reason: "failed again",
      failedAt: "2026-07-12T12:02:00.000Z",
    });
    await store.delete(record.triggerId);
    await expect(store.loadFailure(record.triggerId)).resolves.toBeUndefined();
  });

  it("requires the trigger-store lease and rejects traversal IDs", async () => {
    const { dataRoot, projectRoot, projectId } = await harness();
    const unlocked = new TriggerStore(dataRoot, projectId);
    await expect(unlocked.save(trigger(projectRoot, projectId))).rejects.toThrow("requires the project trigger lease");
    await expect(unlocked.saveFailure({
      schemaVersion: 1,
      triggerId: "trigger_00000001",
      reason: "failed",
      failedAt: "2026-07-12T12:00:00.000Z",
    })).rejects.toThrow("requires the project trigger lease");
    await expect(unlocked.load("trigger_../../escape")).rejects.toThrow("Invalid trigger ID");
    await expect(unlocked.loadFailure("trigger_../../escape")).rejects.toThrow("Invalid trigger ID");
    expect(() => triggerClaimLeasePath(dataRoot, projectId, "trigger_../../escape")).toThrow("Invalid trigger ID");
  });

  it("rejects escaping paths, incoherent states, unknown fields, and unsafe debounce limits", async () => {
    const { store, projectRoot, projectId } = await harness();
    const valid = trigger(projectRoot, projectId);
    await expect(store.save({ ...valid, source: { kind: "filesystem", relativePath: "../outside", debounceMs: 1_000 } }))
      .rejects.toThrow("invalid shape");
    await expect(store.save({ ...valid, source: { kind: "filesystem", relativePath: "src", debounceMs: 10 } }))
      .rejects.toThrow("invalid shape");
    await expect(store.save({ ...valid, state: "running" })).rejects.toThrow("invalid shape");
    await expect(store.save({ ...valid, source: { kind: "event", extra: true } } as unknown as TriggerRecord))
      .rejects.toThrow("invalid shape");
  });

  it("does not clear or overwrite unknown watcher failure state", async () => {
    const { store, dataRoot, projectId } = await harness();
    const directory = join(dataRoot, "projects", projectId, "trigger-failures");
    const path = join(directory, "trigger_00000001.json");
    const unknown = `${JSON.stringify({
      schemaVersion: 2,
      triggerId: "trigger_00000001",
      reason: "future state",
      failedAt: "2026-07-12T12:00:00.000Z",
    }, null, 2)}\n`;
    await mkdir(directory, { recursive: true });
    await writeFile(path, unknown);

    await expect(store.clearFailure("trigger_00000001")).rejects.toThrow("invalid shape");
    await expect(store.saveFailure({
      schemaVersion: 1,
      triggerId: "trigger_00000001",
      reason: "replacement",
      failedAt: "2026-07-12T12:01:00.000Z",
    })).rejects.toThrow("invalid shape");
    expect(await readFile(path, "utf8")).toBe(unknown);
  });

  it("fails closed above the per-project trigger-definition limit", async () => {
    const { store, dataRoot, projectId } = await harness();
    const directory = join(dataRoot, "projects", projectId, "triggers");
    await mkdir(directory, { recursive: true });
    await Promise.all(Array.from({ length: 51 }, (_, index) =>
      writeFile(join(directory, `trigger_${index.toString(16).padStart(8, "0")}.json`), "{}")));
    await expect(store.list()).rejects.toThrow("50-trigger definition limit");
  });

  it("rejects malformed and oversized records read from disk", async () => {
    const { store, dataRoot, projectId } = await harness();
    const directory = join(dataRoot, "projects", projectId, "triggers");
    await mkdir(directory, { recursive: true });
    const path = join(directory, "trigger_00000001.json");
    await writeFile(path, "not-json");
    await expect(store.load("trigger_00000001")).rejects.toBeInstanceOf(SyntaxError);
    await writeFile(path, Buffer.alloc(1024 * 1024 + 1));
    await expect(store.load("trigger_00000001")).rejects.toThrow("exceeds 1048576 bytes");
  });
});
