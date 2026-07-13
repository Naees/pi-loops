import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { UnattendedRunController } from "../src/controller/unattended-run-controller.ts";
import { createProjectId } from "../src/shared/ids.ts";
import { RunStore } from "../src/storage/run-store.ts";
import { TriggerController } from "../src/triggers/controller.ts";
import { RpcWorkerManager } from "../src/worker/rpc-worker-manager.ts";

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", shell: false });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

test("real proactive runtime preserves the active checkout and retains review output", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-loops-proactive-runtime-e2e-"));
  try {
  const repository = join(root, "repository");
  git(root, ["init", "-q", repository]);
  await writeFile(join(repository, "README.md"), "proactive runtime fixture\n");
  git(repository, ["add", "README.md"]);
  git(repository, ["-c", "user.name=Pi Loops E2E", "-c", "user.email=e2e@example.invalid", "commit", "-qm", "initial"]);
  git(repository, ["config", "user.name", "Pi Loops E2E"]);
  git(repository, ["config", "user.email", "e2e@example.invalid"]);
  const projectRoot = await realpath(repository);
  const projectId = createProjectId(projectRoot);
  const dataRoot = join(root, "data");
  const piPackageRoot = join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent");
  const piManifest = JSON.parse(await readFile(join(piPackageRoot, "package.json"), "utf8")) as { version: string };
  const piCli = await realpath(join(piPackageRoot, "dist", "cli.js"));
  const qualificationPlatform = process.env.PI_LOOPS_QUALIFY_PLATFORM;
  if (qualificationPlatform !== undefined && qualificationPlatform !== process.platform) {
    throw new Error(`Qualification platform ${qualificationPlatform} does not match ${process.platform}`);
  }
  const workers = new RpcWorkerManager({
    ...(qualificationPlatform === process.platform ? {
      platform: process.platform,
      qualifiedPlatforms: [process.platform],
      qualification: {
        extensionPaths: [resolve("scripts/fixtures/rpc-lifecycle-extension.ts")],
        provider: "pi-loops-lifecycle",
        model: "controlled",
      },
    } : {}),
    resolveLaunch: async () => ({
      executable: process.execPath,
      argsPrefix: [piCli],
      version: piManifest.version,
      source: "current-node-cli",
    }),
  });
  const unattended = new UnattendedRunController({ dataRoot, repositoryLockRoot: join(root, "locks"), workers });
  const triggerHost = { cwd: projectRoot, notify: (message: string) => process.stdout.write(`${message}\n`) };
  const workerHost = {
    cwd: projectRoot,
    ui: {
      hasUI: true,
      confirm: async () => false,
      select: async () => undefined,
      input: async () => undefined,
      editor: async () => undefined,
      notify: (message: string) => process.stdout.write(`${message}\n`),
    },
    notify: (message: string) => process.stdout.write(`${message}\n`),
    appendRunEntry: () => undefined,
  };
  const evaluator = {
    evaluate: async () => ({
      complete: true,
      needsUser: false,
      reason: "The required deterministic verifier passed.",
      failedCriteria: [],
      feedback: null,
    }),
  };
  const triggers = new TriggerController({ dataRoot });
  await triggers.start(triggerHost, (trigger, runId, signal, kind) =>
    unattended.runTrigger(trigger, runId, evaluator, workerHost, signal, kind));
  const definition = await triggers.create({
    source: { kind: "event" },
    goal: "Create a file named proactive-runtime-result.txt containing exactly PROACTIVE_RUNTIME_OK followed by a newline. Do not modify any other tracked file.",
    budget: { maxCycles: 1, maxActiveMs: 5 * 60_000 },
  }, triggerHost);

  const fired = await triggers.fireEvent(definition.triggerId, projectRoot, "runtime-e2e-1");
  if (fired !== "started") throw new Error(`Expected proactive trigger to start, received ${fired}`);
  const completed = await waitFor(async () => {
    const runs = await new RunStore(dataRoot, projectId).list();
    const run = runs.find((item) => item.triggerId === definition.triggerId);
    if (run && ["awaiting_user", "failed", "cancelled", "interrupted", "stalled", "budget_exhausted"].includes(run.state)) {
      throw new Error(`Proactive runtime ended in ${run.state}: ${run.terminalReason ?? "no reason"}\n${JSON.stringify({ summary: run.latestWorkerSummary, evidence: run.latestEvidence, evaluation: run.latestEvaluation }, null, 2)}`);
    }
    return run?.state === "completed" ? run : undefined;
  }, 5 * 60_000);
  await waitFor(async () => (await triggers.list(projectRoot)).find((trigger) =>
    trigger.triggerId === definition.triggerId && trigger.state === "enabled"), 30_000);

  const reviewText = git(projectRoot, ["show", `pi-loops/${completed.runId}:proactive-runtime-result.txt`]);
  if (reviewText !== "PROACTIVE_RUNTIME_OK") throw new Error(`Unexpected review output: ${reviewText}`);
  try {
    await readFile(join(projectRoot, "proactive-runtime-result.txt"), "utf8");
    throw new Error("Proactive runtime modified the active checkout");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await triggers.shutdown();
  await unattended.shutdown();
  console.log(`Proactive runtime E2E passed: ${completed.runId} on pi-loops/${completed.runId}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 5 * 60_000);
