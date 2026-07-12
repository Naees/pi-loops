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
  const paths: Partial<Record<RunState, RunState[]>> = {
    preflight: ["preflight"],
    queued: ["preflight", "queued"],
    starting: ["preflight", "starting"],
    running: ["preflight", "starting", "running"],
    verifying: ["preflight", "starting", "running", "verifying"],
    evaluating: ["preflight", "starting", "running", "verifying", "evaluating"],
    finalizing: ["preflight", "starting", "running", "verifying", "evaluating", "finalizing"],
    completed: ["preflight", "starting", "running", "verifying", "evaluating", "finalizing", "completed"],
  };
  if (state !== "configuring") {
    const path = paths[state];
    if (!path) throw new Error(`Unsupported test state: ${state}`);
    for (const next of path) move(next);
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

  it("reconciles every persisted transient crash state and is idempotent", async () => {
    const runs = await store();
    const transientStates: RunState[] = ["configuring", "preflight", "queued", "starting", "running", "verifying", "evaluating", "finalizing"];
    for (const [index, state] of transientStates.entries()) await runs.save(run(index + 1, state));
    await runs.save(run(20, "completed"));

    const expected = transientStates.map((_state, index) => `run_${(index + 1).toString(16).padStart(8, "0")}`);
    expect(await runs.reconcileInterrupted(new Date("2026-07-12T00:00:00.000Z"))).toEqual(expected);
    for (const runId of expected) expect((await runs.load(runId))?.state).toBe("interrupted");
    expect((await runs.load("run_00000014"))?.state).toBe("completed");
    expect(await runs.reconcileInterrupted(new Date("2026-07-12T00:01:00.000Z"))).toEqual([]);
  });

  it.each([
    { complete: false, needsUser: false, reason: "", failedCriteria: [], feedback: null },
    { complete: true, needsUser: true, reason: "done", failedCriteria: [], feedback: null },
    { complete: true, needsUser: false, reason: "done", failedCriteria: ["tests"], feedback: null },
  ])("rejects contradictory stored evaluations: %j", async (latestEvaluation) => {
    const runs = await store();
    await expect(runs.save({ ...run(1), latestEvaluation })).rejects.toThrow("invalid shape");
  });

  it("validates unattended worker metadata and completed review commits", async () => {
    const runs = await store();
    const completed = run(1, "completed");
    const scheduled: RunRecord = {
      ...completed,
      mode: "scheduled",
      scheduleId: "schedule_1234abcd",
      worker: {
        repositoryRoot: "/tmp/repository",
        baseCommit: "a".repeat(40),
        branch: completed.runId.replace(/^/, "pi-loops/"),
        worktreePath: "/tmp/worktree",
        sessionDirectory: "/tmp/sessions",
        reviewCommit: "b".repeat(40),
        worktreeRetained: false,
      },
    };
    const worker = scheduled.worker;
    if (!worker) throw new Error("Scheduled test run has no worker metadata");
    await expect(runs.save(scheduled)).resolves.toBeUndefined();
    await expect(runs.save({ ...completed, worker })).rejects.toThrow("invalid shape");
    const incompleteWorker: { -readonly [Key in keyof NonNullable<RunRecord["worker"]>]: NonNullable<RunRecord["worker"]>[Key] } = { ...worker };
    delete incompleteWorker.reviewCommit;
    await expect(runs.save({ ...scheduled, worker: incompleteWorker })).rejects.toThrow("invalid shape");
    await expect(runs.save({
      ...scheduled,
      worker: { ...worker, sessionId: "session-1" },
    })).rejects.toThrow("invalid shape");
    await expect(runs.save({ ...scheduled, budgetDeadlineAt: "not-a-date" })).rejects.toThrow("invalid shape");
  });

  it("evicts the least-recently accessed eligible records with no tombstone", async () => {
    const runs = await store();
    for (let index = 1; index <= 4; index += 1) {
      await runs.save(run(index, "completed"));
      await runs.markAccessed(`run_${index.toString(16).padStart(8, "0")}`, new Date(index * 10_000));
    }
    await runs.markAccessed("run_00000001", new Date(50_000));

    expect(await runs.enforceRetention(2, (item) => item.state === "completed")).toEqual([
      "run_00000002",
      "run_00000003",
    ]);
    expect((await runs.list()).map((item) => item.runId)).toEqual(["run_00000001", "run_00000004"]);
    expect(await runs.load("run_00000002")).toBeUndefined();
    expect(await runs.load("run_00000003")).toBeUndefined();
  });
});
