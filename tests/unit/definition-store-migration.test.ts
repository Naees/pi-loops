import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prepareStoredState = vi.hoisted(() => vi.fn());
vi.mock("../../src/storage/state-migrations.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/storage/state-migrations.js")>(),
  prepareStoredState,
}));

import { createProjectId } from "../../src/shared/ids.js";
import type { ScheduleRecord, TriggerRecord } from "../../src/shared/types.js";
import { acquireWriterLease, releaseWriterLease, type WriterLease } from "../../src/storage/lease.js";
import { ScheduleStore, scheduleLeasePath } from "../../src/storage/schedule-store.js";
import { TriggerStore, triggerLeasePath } from "../../src/storage/trigger-store.js";

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

async function fixture() {
  const dataRoot = await mkdtemp(join(tmpdir(), "pi-loops-definition-migration-"));
  const projectDirectory = await mkdtemp(join(tmpdir(), "pi-loops-definition-project-"));
  temporary.push(dataRoot, projectDirectory);
  const projectRoot = await realpath(projectDirectory);
  const projectId = createProjectId(projectRoot);
  const at = "2026-07-12T12:00:00.000Z";
  const schedule: ScheduleRecord = {
    schemaVersion: 1,
    scheduleId: "schedule_1234abcd",
    projectId,
    projectRoot,
    state: "enabled",
    goal: "before migration",
    constraints: [],
    verifierCommands: [],
    budget: { maxActiveMs: 60_000, maxCycles: 2, stallThreshold: 2 },
    expression: "every 5m",
    normalizedExpression: "every 5 minutes",
    timing: { kind: "recurring", intervalMs: 300_000, anchorAt: at },
    nextFireAt: "2026-07-12T12:05:00.000Z",
    createdAt: at,
    updatedAt: at,
  };
  const trigger: TriggerRecord = {
    schemaVersion: 1,
    triggerId: "trigger_1234abcd",
    projectId,
    projectRoot,
    state: "enabled",
    goal: "before migration",
    constraints: [],
    verifierCommands: [],
    budget: { maxActiveMs: 60_000, maxCycles: 2, stallThreshold: 2 },
    source: { kind: "event" },
    createdAt: at,
    updatedAt: at,
  };
  const schedulePath = join(dataRoot, "projects", projectId, "schedules", `${schedule.scheduleId}.json`);
  const triggerPath = join(dataRoot, "projects", projectId, "triggers", `${trigger.triggerId}.json`);
  await mkdir(join(schedulePath, ".."), { recursive: true });
  await mkdir(join(triggerPath, ".."), { recursive: true });
  const scheduleText = `${JSON.stringify(schedule, null, 2)}\n`;
  const triggerText = `${JSON.stringify(trigger, null, 2)}\n`;
  await writeFile(schedulePath, scheduleText);
  await writeFile(triggerPath, triggerText);
  return { dataRoot, projectId, schedule, trigger, schedulePath, triggerPath, scheduleText, triggerText };
}

function markPrepared(): void {
  prepareStoredState.mockImplementation((_kind: string, value: ScheduleRecord | TriggerRecord) => ({
    value: { ...value, goal: "after migration" },
    migrated: true,
    fromVersion: 0,
    toVersion: 1,
  }));
}

describe("definition-store migration persistence", () => {
  it("does not rewrite prepared definitions without their mutation leases", async () => {
    const current = await fixture();
    markPrepared();
    await expect(new ScheduleStore(current.dataRoot, current.projectId).load(current.schedule.scheduleId))
      .rejects.toThrow("Schedule-store mutation requires the project schedule lease");
    await expect(new TriggerStore(current.dataRoot, current.projectId).load(current.trigger.triggerId))
      .rejects.toThrow("Trigger-store mutation requires the project trigger lease");
    expect(await readFile(current.schedulePath, "utf8")).toBe(current.scheduleText);
    expect(await readFile(current.triggerPath, "utf8")).toBe(current.triggerText);
  });

  it("atomically persists validated definitions under their respective leases", async () => {
    const current = await fixture();
    const scheduleLease = await acquireWriterLease(scheduleLeasePath(current.dataRoot, current.projectId), 5_000);
    const triggerLease = await acquireWriterLease(triggerLeasePath(current.dataRoot, current.projectId), 5_000);
    leases.push(scheduleLease, triggerLease);
    markPrepared();

    await expect(new ScheduleStore(current.dataRoot, current.projectId, scheduleLease).load(current.schedule.scheduleId))
      .resolves.toEqual(expect.objectContaining({ goal: "after migration" }));
    await expect(new TriggerStore(current.dataRoot, current.projectId, triggerLease).load(current.trigger.triggerId))
      .resolves.toEqual(expect.objectContaining({ goal: "after migration" }));
    expect(JSON.parse(await readFile(current.schedulePath, "utf8"))).toEqual(expect.objectContaining({ goal: "after migration" }));
    expect(JSON.parse(await readFile(current.triggerPath, "utf8"))).toEqual(expect.objectContaining({ goal: "after migration" }));
  });
});
