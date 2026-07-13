import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, expect, test, vi } from "vitest";

const configuredPackageRoot = process.env.PI_LOOPS_PACKED_ROOT;
if (!configuredPackageRoot) throw new Error("PI_LOOPS_PACKED_ROOT is required");
const packageRoot = configuredPackageRoot;
const temporary: string[] = [];
afterAll(async () => Promise.all(temporary.map((path) => rm(path, { recursive: true, force: true }))));

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", shell: false });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

async function packedImport(path: string) {
  return import(pathToFileURL(join(packageRoot, path)).href);
}

test("packed scheduled writer isolates and retains review output", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi loops packed scheduled runtime "));
  temporary.push(root);
  const repository = join(root, "repository");
  git(root, ["init", "-q", repository]);
  await writeFile(join(repository, "README.md"), "initial\n");
  git(repository, ["add", "README.md"]);
  git(repository, ["-c", "user.name=Pi Loops E2E", "-c", "user.email=e2e@example.invalid", "commit", "-qm", "initial"]);
  git(repository, ["config", "user.name", "Pi Loops E2E"]);
  git(repository, ["config", "user.email", "e2e@example.invalid"]);

  const [{ UnattendedRunController }, { createProjectId }, { RunStore }, { QUALIFIED_UNATTENDED_PLATFORMS }] = await Promise.all([
    packedImport("src/controller/unattended-run-controller.ts"),
    packedImport("src/shared/ids.ts"),
    packedImport("src/storage/run-store.ts"),
    packedImport("src/worker/rpc-worker-manager.ts"),
  ]);
  expect(QUALIFIED_UNATTENDED_PLATFORMS).toContain(process.platform);
  const projectRoot = await realpath(repository);
  const projectId = createProjectId(projectRoot);
  const dataRoot = join(root, "data");
  const runId = "run_1234abcd";
  const schedule = {
    schemaVersion: 1,
    scheduleId: "schedule_1234abcd",
    projectId,
    projectRoot,
    state: "running",
    goal: "create packed-result.txt",
    constraints: [],
    verifierCommands: [],
    budget: { maxActiveMs: 60_000, maxCycles: 2, stallThreshold: 2 },
    expression: "in 1m",
    normalizedExpression: "in 1 minute",
    timing: { kind: "once", fireAt: new Date(Date.now() + 60_000).toISOString() },
    activeRunId: runId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const worker = {
    identity: { pid: process.pid, ownershipToken: "packed-owner", piVersion: "0.80.6", sessionId: "packed-session", sessionFile: join(dataRoot, "session.jsonl") },
    runCycle: vi.fn(async (_message: string) => {
      await writeFile(join(workerCwd, "packed-result.txt"), "packed scheduled output\n");
      return { lastAssistantText: "implemented packed result", events: [] };
    }),
    stop: vi.fn(async () => ({ code: 0, signal: null })),
  };
  let workerCwd = "";
  const workers = { launch: vi.fn(async (spec: { cwd: string }) => { workerCwd = spec.cwd; return worker; }) };
  const host = {
    cwd: projectRoot,
    ui: { hasUI: true, confirm: async () => true, select: async () => undefined, input: async () => undefined, editor: async () => undefined, notify: vi.fn() },
    notify: vi.fn(),
    appendRunEntry: vi.fn(),
  };
  const evaluator = { evaluate: vi.fn(async () => ({ complete: true, needsUser: false, reason: "accepted", failedCriteria: [], feedback: null })) };
  const controller = new UnattendedRunController({ dataRoot, repositoryLockRoot: join(root, "locks"), workers });
  await expect(controller.runSchedule(schedule, runId, evaluator, host, new AbortController().signal, "start"))
    .resolves.toEqual({ status: "finished" });

  const stored = await new RunStore(dataRoot, projectId).load(runId);
  expect(stored).toEqual(expect.objectContaining({ state: "completed", worker: expect.objectContaining({ worktreeRetained: false }) }));
  expect(git(repository, ["branch", "--show-current"])).not.toBe(`pi-loops/${runId}`);
  expect(() => git(repository, ["show", `pi-loops/${runId}:packed-result.txt`])).not.toThrow();
  await expect(readFile(join(repository, "packed-result.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

test("packed proactive writer isolates and retains review output", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi loops packed proactive runtime "));
  temporary.push(root);
  const repository = join(root, "repository");
  git(root, ["init", "-q", repository]);
  await writeFile(join(repository, "README.md"), "initial\n");
  git(repository, ["add", "README.md"]);
  git(repository, ["-c", "user.name=Pi Loops E2E", "-c", "user.email=e2e@example.invalid", "commit", "-qm", "initial"]);
  git(repository, ["config", "user.name", "Pi Loops E2E"]);
  git(repository, ["config", "user.email", "e2e@example.invalid"]);

  const [{ UnattendedRunController }, { createProjectId }, { RunStore }] = await Promise.all([
    packedImport("src/controller/unattended-run-controller.ts"),
    packedImport("src/shared/ids.ts"),
    packedImport("src/storage/run-store.ts"),
  ]);
  const projectRoot = await realpath(repository);
  const projectId = createProjectId(projectRoot);
  const dataRoot = join(root, "data");
  const runId = "run_deadbeef";
  const trigger = {
    schemaVersion: 1,
    triggerId: "trigger_deadbeef",
    projectId,
    projectRoot,
    state: "running",
    goal: "create proactive-result.txt",
    constraints: [],
    verifierCommands: [],
    budget: { maxActiveMs: 60_000, maxCycles: 2, stallThreshold: 2 },
    source: { kind: "event" },
    activeRunId: runId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  let workerCwd = "";
  const worker = {
    identity: { pid: process.pid, ownershipToken: "packed-proactive-owner", piVersion: "0.80.6", sessionId: "packed-proactive-session", sessionFile: join(dataRoot, "proactive-session.jsonl") },
    runCycle: vi.fn(async () => {
      await writeFile(join(workerCwd, "proactive-result.txt"), "packed proactive output\n");
      return { lastAssistantText: "implemented proactive result", events: [] };
    }),
    stop: vi.fn(async () => ({ code: 0, signal: null })),
  };
  const workers = { launch: vi.fn(async (spec: { cwd: string }) => { workerCwd = spec.cwd; return worker; }) };
  const host = {
    cwd: projectRoot,
    ui: { hasUI: true, confirm: async () => true, select: async () => undefined, input: async () => undefined, editor: async () => undefined, notify: vi.fn() },
    notify: vi.fn(),
    appendRunEntry: vi.fn(),
  };
  const evaluator = { evaluate: vi.fn(async () => ({ complete: true, needsUser: false, reason: "accepted", failedCriteria: [], feedback: null })) };
  const controller = new UnattendedRunController({ dataRoot, repositoryLockRoot: join(root, "locks"), workers });
  await expect(controller.runTrigger(trigger, runId, evaluator, host, new AbortController().signal, "start"))
    .resolves.toEqual({ status: "finished" });

  const stored = await new RunStore(dataRoot, projectId).load(runId);
  expect(stored).toEqual(expect.objectContaining({ mode: "proactive", triggerId: trigger.triggerId, state: "completed", worker: expect.objectContaining({ worktreeRetained: false }) }));
  expect(git(repository, ["branch", "--show-current"])).not.toBe(`pi-loops/${runId}`);
  expect(() => git(repository, ["show", `pi-loops/${runId}:proactive-result.txt`])).not.toThrow();
  await expect(readFile(join(repository, "proactive-result.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});
