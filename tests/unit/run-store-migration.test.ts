import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prepareStoredState = vi.hoisted(() => vi.fn());
vi.mock("../../src/storage/state-migrations.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/storage/state-migrations.js")>(),
  prepareStoredState,
}));

import type { RunRecord } from "../../src/shared/types.js";
import { acquireWriterLease, releaseWriterLease, type WriterLease } from "../../src/storage/lease.js";
import { RunStore, writerLeasePath } from "../../src/storage/run-store.js";

const projectId = "project_1234567890abcdef";
const temporary: string[] = [];
const leases: WriterLease[] = [];

afterEach(async () => {
  await Promise.all(leases.splice(0).map((lease) => releaseWriterLease(lease).catch(() => undefined)));
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

beforeEach(() => {
  prepareStoredState.mockReset();
  prepareStoredState.mockImplementation((_kind: string, value: unknown) => ({ value, migrated: false }));
});

function record(goal: string): RunRecord {
  return {
    schemaVersion: 1,
    runId: "run_1234abcd",
    projectId,
    mode: "goal",
    state: "configuring",
    goal,
    budget: { maxActiveMs: 60_000, maxCycles: 2, stallThreshold: 2 },
    cycle: 0,
    createdAt: "2026-07-12T12:00:00.000Z",
    updatedAt: "2026-07-12T12:00:00.000Z",
    transitions: [],
  };
}

async function rawStore(): Promise<{ dataRoot: string; path: string; original: string }> {
  const dataRoot = await mkdtemp(join(tmpdir(), "pi-loops-run-migration-"));
  temporary.push(dataRoot);
  const path = join(dataRoot, "projects", projectId, "runs", "run_1234abcd.json");
  await mkdir(join(path, ".."), { recursive: true });
  const original = `${JSON.stringify(record("before migration"), null, 2)}\n`;
  await writeFile(path, original);
  return { dataRoot, path, original };
}

describe("run-store migration persistence", () => {
  it("refuses to persist prepared state without the project mutation lease", async () => {
    const { dataRoot, path, original } = await rawStore();
    prepareStoredState.mockImplementation((_kind: string, value: RunRecord) => ({
      value: { ...value, goal: "after migration" },
      migrated: true,
      fromVersion: 0,
      toVersion: 1,
    }));

    await expect(new RunStore(dataRoot, projectId).load("run_1234abcd"))
      .rejects.toThrow("Run-store mutation requires the project writer lease");
    expect(await readFile(path, "utf8")).toBe(original);
  });

  it("atomically persists validated prepared state while holding the project lease", async () => {
    const { dataRoot, path } = await rawStore();
    const lease = await acquireWriterLease(writerLeasePath(dataRoot, projectId), 5_000);
    leases.push(lease);
    prepareStoredState.mockImplementation((_kind: string, value: RunRecord) => ({
      value: { ...value, goal: "after migration" },
      migrated: true,
      fromVersion: 0,
      toVersion: 1,
    }));

    await expect(new RunStore(dataRoot, projectId, lease).load("run_1234abcd"))
      .resolves.toEqual(expect.objectContaining({ goal: "after migration" }));
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(expect.objectContaining({ goal: "after migration" }));
  });
});
