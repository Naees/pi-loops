import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Packed state compatibility environment is missing ${name}`);
  return value;
}

const packageRoot = requiredEnvironment("PI_LOOPS_PACKED_ROOT");
const dataRoot = requiredEnvironment("PI_LOOPS_STATE_DATA_ROOT");
const configuredProjectRoot = requiredEnvironment("PI_LOOPS_STATE_PROJECT_ROOT");
const fixturesRoot = requiredEnvironment("PI_LOOPS_STATE_FIXTURES_ROOT");
const seed = process.env.PI_LOOPS_STATE_SEED === "1";

async function packedImport(path: string) {
  return import(pathToFileURL(join(packageRoot, path)).href);
}

function substitute(value: unknown, projectId: string, projectRoot: string): unknown {
  if (typeof value === "string") {
    return value.replaceAll("{{PROJECT_ID}}", projectId).replaceAll("{{PROJECT_ROOT}}", projectRoot);
  }
  if (Array.isArray(value)) return value.map((item) => substitute(item, projectId, projectRoot));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, projectId, projectRoot)]));
  }
  return value;
}

async function fixture(name: string, projectId: string, projectRoot: string): Promise<unknown> {
  const parsed = JSON.parse(await readFile(join(fixturesRoot, `${name}.json`), "utf8")) as unknown;
  return substitute(parsed, projectId, projectRoot);
}

async function writeFixture(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

test("packed package reads frozen version-one state without rewriting it", async () => {
  const projectRoot = await realpath(configuredProjectRoot);
  const [{ createProjectId }, { RunStore }, { ScheduleStore }, { TriggerStore }, { NoticeStore }, config] = await Promise.all([
    packedImport("src/shared/ids.ts"),
    packedImport("src/storage/run-store.ts"),
    packedImport("src/storage/schedule-store.ts"),
    packedImport("src/storage/trigger-store.ts"),
    packedImport("src/storage/notices.ts"),
    packedImport("src/config/config.ts"),
  ]);
  const projectId = createProjectId(projectRoot);
  const projectDirectory = join(dataRoot, "projects", projectId);
  const paths = {
    run: join(projectDirectory, "runs", "run_1234abcd.json"),
    completedRun: join(projectDirectory, "runs", "run_b16b00b5.json"),
    retainedRun: join(projectDirectory, "runs", "run_cafebabe.json"),
    schedule: join(projectDirectory, "schedules", "schedule_1234abcd.json"),
    trigger: join(projectDirectory, "triggers", "trigger_1234abcd.json"),
    notices: join(dataRoot, "notices.json"),
    config: join(dataRoot, "config-v1.json"),
  };

  if (seed) {
    await writeFixture(paths.run, await fixture("run", projectId, projectRoot));
    await writeFixture(paths.completedRun, await fixture("run-completed", projectId, projectRoot));
    await writeFixture(paths.retainedRun, await fixture("run-retained", projectId, projectRoot));
    await writeFixture(paths.schedule, await fixture("schedule", projectId, projectRoot));
    await writeFixture(paths.trigger, await fixture("trigger", projectId, projectRoot));
    await writeFixture(paths.notices, await fixture("notices", projectId, projectRoot));
    await writeFixture(paths.config, await fixture("config", projectId, projectRoot));
  }

  const before = new Map(await Promise.all(Object.entries(paths).map(async ([name, path]) => [name, await readFile(path, "utf8")] as const)));
  const runStore = new RunStore(dataRoot, projectId);
  const scheduleStore = new ScheduleStore(dataRoot, projectId);
  const triggerStore = new TriggerStore(dataRoot, projectId);
  await expect(runStore.load("run_1234abcd")).resolves.toEqual(expect.objectContaining({
    schemaVersion: 1,
    projectId,
    state: "interrupted",
    budgetEpoch: 1,
  }));
  await expect(runStore.load("run_b16b00b5")).resolves.toEqual(expect.objectContaining({
    schemaVersion: 1,
    projectId,
    state: "completed",
    terminalReason: "accepted",
  }));
  await expect(runStore.load("run_cafebabe")).resolves.toEqual(expect.objectContaining({
    schemaVersion: 1,
    projectId,
    mode: "scheduled",
    state: "interrupted",
    worker: expect.objectContaining({
      branch: "pi-loops/run_cafebabe",
      worktreeRetained: true,
    }),
  }));
  await expect(scheduleStore.load("schedule_1234abcd")).resolves.toEqual(expect.objectContaining({
    schemaVersion: 1,
    projectRoot,
    state: "enabled",
  }));
  await expect(triggerStore.load("trigger_1234abcd")).resolves.toEqual(expect.objectContaining({
    schemaVersion: 1,
    projectRoot,
    state: "enabled",
    source: { kind: "event" },
  }));
  await expect(new NoticeStore(dataRoot).shouldShowSubagentsRecommendation()).resolves.toBe(false);
  expect(config.validateConfig(JSON.parse(await readFile(paths.config, "utf8")))).toEqual(expect.objectContaining({ schemaVersion: 1 }));

  for (const [name, path] of Object.entries(paths)) {
    expect(await readFile(path, "utf8"), `${name} fixture was unexpectedly rewritten`).toBe(before.get(name));
  }

  for (const future of [
    { name: "run", idKey: "runId", id: "run_deadbeef", path: join(projectDirectory, "runs", "run_deadbeef.json"), load: () => runStore.load("run_deadbeef") },
    { name: "schedule", idKey: "scheduleId", id: "schedule_deadbeef", path: join(projectDirectory, "schedules", "schedule_deadbeef.json"), load: () => scheduleStore.load("schedule_deadbeef") },
    { name: "trigger", idKey: "triggerId", id: "trigger_deadbeef", path: join(projectDirectory, "triggers", "trigger_deadbeef.json"), load: () => triggerStore.load("trigger_deadbeef") },
  ]) {
    const current = JSON.parse(before.get(future.name) ?? "{}") as Record<string, unknown>;
    const serialized = `${JSON.stringify({ ...current, schemaVersion: 2, [future.idKey]: future.id }, null, 2)}\n`;
    await writeFixture(future.path, JSON.parse(serialized));
    await expect(future.load()).rejects.toMatchObject({
      name: "UnsupportedStoredStateVersionError",
      message: expect.stringContaining("schemaVersion 2 is newer than supported version 1"),
    });
    expect(await readFile(future.path, "utf8")).toBe(serialized);
    await rm(future.path);
  }
});
