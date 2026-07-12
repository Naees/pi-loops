import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { transitionRun } from "../../src/controller/state-machine.js";
import type { RunRecord, RunState } from "../../src/shared/types.js";
import { acquireWriterLease, releaseWriterLease, type WriterLease } from "../../src/storage/lease.js";
import { RunStore, writerLeasePath } from "../../src/storage/run-store.js";

const temporaryDirectories: string[] = [];
const activeLeases: WriterLease[] = [];
const projectId = "project_1234567890abcdef";

afterEach(async () => {
  await Promise.all(activeLeases.splice(0).map((lease) => releaseWriterLease(lease).catch(() => undefined)));
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function store(): Promise<RunStore> {
  const directory = await mkdtemp(join(tmpdir(), "pi-loops-store-"));
  temporaryDirectories.push(directory);
  const lease = await acquireWriterLease(writerLeasePath(directory, projectId), 5_000);
  activeLeases.push(lease);
  return new RunStore(directory, projectId, lease);
}

function run(index: number, state: RunState = "configuring"): RunRecord {
  const timestamp = new Date(index * 1_000).toISOString();
  let record: RunRecord = {
    schemaVersion: 1,
    runId: `run_${index.toString(16).padStart(8, "0")}`,
    projectId,
    mode: "goal",
    state: "configuring",
    goal: `goal ${index}`,
    budget: { maxActiveMs: 10_800_000, maxCycles: 15, stallThreshold: 3 },
    cycle: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    transitions: [],
  };

  const move = (to: RunState): void => {
    record = transitionRun(record, to, `move to ${to}`, new Date(Date.parse(record.updatedAt) + 1));
  };
  if (state !== "configuring") {
    move("preflight");
    move("starting");
    move("running");
  }
  if (state === "completed") {
    move("verifying");
    move("evaluating");
    move("finalizing");
    move("completed");
  } else if (state !== "configuring" && state !== "running") {
    throw new Error(`Unsupported test state: ${state}`);
  }
  return record;
}

describe("run store", () => {
  it("rejects mutations without the project writer lease", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-loops-store-"));
    temporaryDirectories.push(directory);
    const runs = new RunStore(directory, projectId);
    await expect(runs.save(run(1))).rejects.toThrow("requires the project writer lease");
  });

  it("saves, loads, lists, and deletes run records", async () => {
    const runs = await store();
    await runs.save(run(1));
    await runs.save(run(2));

    expect((await runs.load("run_00000001"))?.goal).toBe("goal 1");
    expect((await runs.list()).map((item) => item.runId)).toEqual(["run_00000001", "run_00000002"]);
    await runs.delete("run_00000001");
    expect(await runs.load("run_00000001")).toBeUndefined();
  });

  it("reconciles active crash states to interrupted", async () => {
    const runs = await store();
    await runs.save(run(1, "running"));
    await runs.save(run(2, "completed"));

    expect(await runs.reconcileInterrupted(new Date("2026-07-12T00:00:00.000Z"))).toEqual(["run_00000001"]);
    expect((await runs.load("run_00000001"))?.state).toBe("interrupted");
    expect((await runs.load("run_00000002"))?.state).toBe("completed");
  });

  it.each([
    { complete: false, needsUser: false, reason: "", failedCriteria: [], feedback: null },
    { complete: true, needsUser: true, reason: "done", failedCriteria: [], feedback: null },
    { complete: true, needsUser: false, reason: "done", failedCriteria: ["tests"], feedback: null },
  ])("rejects contradictory stored evaluations: %j", async (latestEvaluation) => {
    const runs = await store();
    await expect(runs.save({ ...run(1), latestEvaluation })).rejects.toThrow("invalid shape");
  });

  it("evicts complete eligible records with no tombstone", async () => {
    const runs = await store();
    for (let index = 1; index <= 4; index += 1) await runs.save(run(index, "completed"));

    const evicted = await runs.enforceRetention(2, (item) => item.state === "completed");
    expect(evicted).toHaveLength(2);
    expect(await runs.list()).toHaveLength(2);
    for (const runId of evicted) expect(await runs.load(runId)).toBeUndefined();
  });
});
