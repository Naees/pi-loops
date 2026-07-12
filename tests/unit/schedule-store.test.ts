import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProjectId } from "../../src/shared/ids.js";
import type { ScheduleRecord } from "../../src/shared/types.js";
import { acquireWriterLease, releaseWriterLease, type WriterLease } from "../../src/storage/lease.js";
import { ScheduleStore, scheduleLeasePath } from "../../src/storage/schedule-store.js";

const temporaryDirectories: string[] = [];
const activeLeases: WriterLease[] = [];

afterEach(async () => {
  await Promise.all(activeLeases.splice(0).map((lease) => releaseWriterLease(lease).catch(() => undefined)));
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function harness(): Promise<{ store: ScheduleStore; dataRoot: string; projectRoot: string; projectId: string }> {
  const dataRoot = await mkdtemp(join(tmpdir(), "pi-loops-schedule-store-"));
  const projectDirectory = await mkdtemp(join(tmpdir(), "pi-loops-schedule-project-"));
  temporaryDirectories.push(dataRoot, projectDirectory);
  const projectRoot = await realpath(projectDirectory);
  const projectId = createProjectId(projectRoot);
  const lease = await acquireWriterLease(scheduleLeasePath(dataRoot, projectId), 5_000);
  activeLeases.push(lease);
  return { store: new ScheduleStore(dataRoot, projectId, lease), dataRoot, projectRoot, projectId };
}

function schedule(projectRoot: string, projectId: string, index = 1): ScheduleRecord {
  const createdAt = "2026-07-12T12:00:00.000Z";
  return {
    schemaVersion: 1,
    scheduleId: `schedule_${index.toString(16).padStart(8, "0")}`,
    projectId,
    projectRoot,
    state: "enabled",
    goal: `goal ${index}`,
    constraints: [],
    verifierCommands: [],
    budget: { maxActiveMs: 10_800_000, maxCycles: 15, stallThreshold: 3 },
    expression: "every 5m",
    normalizedExpression: "every 5 minutes",
    timing: { kind: "recurring", intervalMs: 300_000, anchorAt: createdAt },
    nextFireAt: "2026-07-12T12:05:00.000Z",
    createdAt,
    updatedAt: createdAt,
  };
}

describe("schedule store", () => {
  it("saves, loads, lists, and explicitly deletes schedules", async () => {
    const { store, projectRoot, projectId } = await harness();
    await store.save(schedule(projectRoot, projectId, 2));
    await store.save(schedule(projectRoot, projectId, 1));

    expect((await store.list()).map((item) => item.scheduleId)).toEqual(["schedule_00000001", "schedule_00000002"]);
    expect((await store.load("schedule_00000001"))?.goal).toBe("goal 1");
    await store.delete("schedule_00000001");
    expect(await store.load("schedule_00000001")).toBeUndefined();
  });

  it("rejects mutation without the project schedule lease", async () => {
    const { dataRoot, projectRoot, projectId } = await harness();
    const unlocked = new ScheduleStore(dataRoot, projectId);
    await expect(unlocked.save(schedule(projectRoot, projectId))).rejects.toThrow("requires the project schedule lease");
  });

  it("rejects incoherent state and project bindings", async () => {
    const { store, projectRoot, projectId } = await harness();
    await expect(store.save({ ...schedule(projectRoot, projectId), projectRoot: "/tmp/wrong-project" })).rejects.toThrow("invalid shape");
    await expect(store.save({
      ...schedule(projectRoot, projectId),
      state: "pending_coalesced",
      activeRunId: "run_1234abcd",
    })).rejects.toThrow("invalid shape");
  });

  it("rejects noncanonical timestamps, incoherent timing, and short recurrence", async () => {
    const { store, projectRoot, projectId } = await harness();
    const valid = schedule(projectRoot, projectId);
    await expect(store.save({ ...valid, nextFireAt: "2026-07-12 12:05:00Z" })).rejects.toThrow("invalid shape");
    await expect(store.save({ ...valid, nextFireAt: "2026-07-12T12:06:00.000Z" })).rejects.toThrow("invalid shape");
    await expect(store.save({
      ...valid,
      timing: { kind: "recurring", intervalMs: 60_000, anchorAt: valid.createdAt },
      nextFireAt: "2026-07-12T12:01:00.000Z",
    })).rejects.toThrow("invalid shape");
    await expect(store.save({ ...valid, state: "paused", pauseReason: "user" })).rejects.toThrow("invalid shape");
  });

  it("rejects invalid schedule IDs before path construction", async () => {
    const { store } = await harness();
    await expect(store.load("schedule_../../escape")).rejects.toThrow("Invalid schedule ID");
  });
});
