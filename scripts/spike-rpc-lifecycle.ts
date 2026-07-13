#!/usr/bin/env node

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { RpcSpikeClient, type RpcEnvelope } from "./fixtures/rpc-spike-client.ts";

const PROVIDER = "pi-loops-lifecycle";
const MODEL = "controlled";
const PROCESS_EXIT_TIMEOUT_MS = 5_000;
const EVENT_TIMEOUT_MS = 30_000;
const POST_SETTLEMENT_QUIET_MS = 150;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function run(command: string, args: readonly string[], cwd?: string): string {
  const result = spawnSync(command, [...args], { cwd, encoding: "utf8", shell: false, timeout: 10_000 });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result.stdout.trim();
}

interface PiCommand {
  readonly executable: string;
  readonly argsPrefix: readonly string[];
  readonly version: string;
}

async function resolvePiCommand(): Promise<PiCommand> {
  if (!["darwin", "linux", "win32"].includes(process.platform)) {
    throw new Error(`The lifecycle qualification does not support ${process.platform}`);
  }
  const requested = process.env.PI_LOOPS_SPIKE_PI ?? process.env.PI_LOOPS_TEST_PI;
  const candidate = await realpath(requested ?? join(
    process.cwd(),
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "cli.js",
  ));
  await access(candidate);
  const isNodeCli = candidate.replaceAll("\\", "/").toLowerCase().endsWith("/dist/cli.js");
  const executable = isNodeCli ? await realpath(process.execPath) : candidate;
  const argsPrefix = isNodeCli ? [candidate] : [];
  const version = run(executable, [...argsPrefix, "--version"]);
  assert(/^0\.80\.6(?:\s|$)/.test(version), `Lifecycle qualification requires explicitly validated Pi 0.80.6, received: ${version}`);
  return { executable, argsPrefix, version };
}

function isType(type: string): (message: RpcEnvelope) => boolean {
  return (message) => message.type === type;
}

function isTextDelta(message: RpcEnvelope): boolean {
  if (message.type !== "message_update") return false;
  const event = message.assistantMessageEvent;
  return typeof event === "object" && event !== null && (event as Record<string, unknown>).type === "text_delta";
}

function assistantWasAborted(message: RpcEnvelope): boolean {
  if (message.type !== "message_end") return false;
  const assistant = message.message;
  return typeof assistant === "object" && assistant !== null &&
    (assistant as Record<string, unknown>).role === "assistant" &&
    (assistant as Record<string, unknown>).stopReason === "aborted";
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function removeTemporaryRoot(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || !["EBUSY", "ENOTEMPTY", "EPERM"].includes(code ?? "") || Date.now() >= deadline) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
  }
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  throw new Error(`Timed out waiting for file: ${path}`);
}

async function waitForProcessExit(pid: number, timeoutMs = PROCESS_EXIT_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  throw new Error(`Process ${pid} survived ${timeoutMs}ms`);
}

async function observeSettlementQuietPeriod(): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, POST_SETTLEMENT_QUIET_MS));
}

function responseData(message: RpcEnvelope): Record<string, unknown> {
  assert(message.type === "response" && message.success === true, `Expected successful RPC response: ${JSON.stringify(message)}`);
  assert(typeof message.data === "object" && message.data !== null, `RPC response has no object data: ${JSON.stringify(message)}`);
  return message.data as Record<string, unknown>;
}

function baseArgs(extensionPath: string, watchdogPath: string, sessionDirectory: string): string[] {
  return [
    "--mode", "rpc",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--approve",
    "--extension", extensionPath,
    "--extension", watchdogPath,
    "--provider", PROVIDER,
    "--model", MODEL,
    "--session-dir", sessionDirectory,
  ];
}

async function createWorktree(root: string): Promise<{ repository: string; worktree: string }> {
  const repository = join(root, "repository");
  const worktree = join(root, "worktree");
  await mkdir(repository);
  run("git", ["init", "-q"], repository);
  await writeFile(join(repository, "README.md"), "# lifecycle spike\n", "utf8");
  run("git", ["add", "README.md"], repository);
  run("git", ["-c", "user.name=Pi Loops Spike", "-c", "user.email=spike@example.invalid", "commit", "-qm", "initial"], repository);
  run("git", ["worktree", "add", "-qb", "pi-loops/lifecycle-spike", worktree], repository);
  return { repository, worktree };
}

async function runLifecycleScenarios(command: PiCommand): Promise<Record<string, unknown>> {
  const root = await mkdtemp(join(tmpdir(), "pi-loops-rpc-lifecycle-"));
  const sessionDirectory = join(root, "sessions");
  const pidFile = join(root, "descendants.json");
  const extensionPath = resolve("scripts/fixtures/rpc-lifecycle-extension.ts");
  const watchdogPath = resolve("src/extension/index.ts");
  const { worktree } = await createWorktree(root);
  const canonicalWorktree = await realpath(worktree);
  const args = baseArgs(extensionPath, watchdogPath, sessionDirectory);
  const absoluteDeadlineMs = Date.now() + 120_000;
  const environment = {
    ...process.env,
    PI_LOOPS_CHILD: "rpc-lifecycle-spike",
    PI_LOOPS_CHILD_DEADLINE_MS: String(absoluteDeadlineMs),
    PI_LOOPS_SPIKE_PID_FILE: pidFile,
  };
  const client = new RpcSpikeClient(command.executable, [...command.argsPrefix, ...args], {
    cwd: worktree,
    env: environment,
    absoluteDeadlineMs,
  });

  try {
    const initialState = responseData(await client.send({ type: "get_state" }));
    assert(initialState.isStreaming === false, "RPC child started in a streaming state");
    const sessionId = initialState.sessionId;
    const sessionFile = initialState.sessionFile;
    assert(typeof sessionId === "string" && typeof sessionFile === "string", "RPC child did not allocate a persistent session path");

    const launchResolutionStart = client.checkpoint();
    await client.send({ type: "prompt", message: "/rpc-lifecycle-launch-command" });
    const launchNotification = await client.waitFor(
      (message) => message.type === "extension_ui_request" && message.method === "notify" &&
        typeof message.message === "string" && message.message.startsWith("PI_LOOPS_LAUNCH_COMMAND "),
      { after: launchResolutionStart, timeoutMs: EVENT_TIMEOUT_MS },
    );
    const launchCommand = JSON.parse((launchNotification.message as string).slice("PI_LOOPS_LAUNCH_COMMAND ".length)) as Record<string, unknown>;
    assert(launchCommand.source === "current-node-cli", `Unexpected current-Pi launch source: ${JSON.stringify(launchCommand)}`);
    assert(launchCommand.version === "0.80.6", `Unexpected current-Pi launch version: ${JSON.stringify(launchCommand)}`);
    assert(Array.isArray(launchCommand.argsPrefix) && launchCommand.argsPrefix.length === 1, "Current-Pi launch command did not retain its CLI prefix");

    const completionStart = client.checkpoint();
    await client.send({ type: "prompt", message: "PI_LOOPS_SPIKE_COMPLETE" });
    await client.waitFor(isType("agent_settled"), { after: completionStart, timeoutMs: EVENT_TIMEOUT_MS });
    await observeSettlementQuietPeriod();
    const completionEvents = client.messages.slice(completionStart);
    assert(completionEvents.some(isType("agent_start")), "Controlled prompt emitted no agent_start");
    assert(completionEvents.filter(isType("agent_settled")).length === 1, "Controlled prompt did not settle exactly once");
    await waitForFile(sessionFile);
    const sessionHeader = JSON.parse((await readFile(sessionFile, "utf8")).split("\n", 1)[0] ?? "null") as Record<string, unknown> | null;
    assert(sessionHeader?.type === "session" && typeof sessionHeader.cwd === "string", "Persistent session header is invalid");
    assert(await realpath(sessionHeader.cwd) === canonicalWorktree, "RPC child session was not created in the isolated worktree");
    const settledState = responseData(await client.send({ type: "get_state" }));
    assert(settledState.isStreaming === false, "Controlled prompt remained streaming after agent_settled");

    const streamStart = client.checkpoint();
    const streamPrompt = client.send({ type: "prompt", message: "PI_LOOPS_SPIKE_STREAM" });
    await client.waitFor(isTextDelta, { after: streamStart, timeoutMs: EVENT_TIMEOUT_MS });
    await streamPrompt;
    await client.send({ type: "abort" });
    await client.waitFor(isType("agent_settled"), { after: streamStart, timeoutMs: EVENT_TIMEOUT_MS });
    await observeSettlementQuietPeriod();
    const streamEvents = client.messages.slice(streamStart);
    assert(streamEvents.some(assistantWasAborted), "Streaming abort produced no aborted assistant message");
    assert(streamEvents.filter(isType("agent_settled")).length === 1, "Streaming abort did not settle exactly once");
    const streamSettledIndex = client.messages.findIndex((message, index) => index >= streamStart && message.type === "agent_settled");
    assert(streamSettledIndex >= 0, "Streaming settlement index was not found");
    const postStreamState = responseData(await client.send({ type: "get_state" }));
    assert(postStreamState.isStreaming === false, "RPC child was not reusable after streaming abort");
    assert(
      !client.messages.slice(streamSettledIndex + 1).some((message) => isTextDelta(message) || message.type.startsWith("tool_execution_")),
      "Text or tool events arrived after streaming settlement",
    );

    const toolStart = client.checkpoint();
    const toolPrompt = client.send({ type: "prompt", message: "PI_LOOPS_SPIKE_TOOL" });
    await client.waitFor((message) => message.type === "tool_execution_start" && message.toolName === "bash", {
      after: toolStart,
      timeoutMs: EVENT_TIMEOUT_MS,
    });
    await toolPrompt;
    await waitForFile(pidFile);
    const pids = JSON.parse(await readFile(pidFile, "utf8")) as { parentPid: number; childPid: number };
    assert(Number.isSafeInteger(pids.parentPid) && Number.isSafeInteger(pids.childPid), "Tool fixture wrote invalid descendant PIDs");
    await client.send({ type: "abort" });
    await client.waitFor(isType("agent_settled"), { after: toolStart, timeoutMs: EVENT_TIMEOUT_MS });
    await Promise.all([waitForProcessExit(pids.parentPid), waitForProcessExit(pids.childPid)]);
    await observeSettlementQuietPeriod();
    const toolEvents = client.messages.slice(toolStart);
    assert(toolEvents.some((message) => message.type === "tool_execution_end" && message.toolName === "bash"), "Tool abort emitted no tool_execution_end");
    assert(toolEvents.filter(isType("agent_settled")).length === 1, "Tool abort did not settle exactly once");
    const toolSettledIndex = client.messages.findIndex((message, index) => index >= toolStart && message.type === "agent_settled");
    assert(toolSettledIndex >= 0, "Tool settlement index was not found");
    assert(
      !client.messages.slice(toolSettledIndex + 1).some((message) => isTextDelta(message) || message.type.startsWith("tool_execution_")),
      "Text or tool events arrived after tool settlement",
    );

    const uiStart = client.checkpoint();
    const uiPrompt = client.send({ type: "prompt", message: "/rpc-lifecycle-confirm" });
    const confirmation = await client.waitFor((message) => message.type === "extension_ui_request" && message.method === "confirm", {
      after: uiStart,
      timeoutMs: EVENT_TIMEOUT_MS,
    });
    assert(typeof confirmation.id === "string", "UI confirmation request has no ID");
    client.write({ type: "extension_ui_response", id: confirmation.id, confirmed: true });
    await client.waitFor(
      (message) => message.type === "extension_ui_request" && message.method === "notify" && message.message === "PI_LOOPS_UI_RELAY_CONFIRMED",
      { after: uiStart, timeoutMs: EVENT_TIMEOUT_MS },
    );
    await uiPrompt;

    client.closeStdin();
    const firstExit = await Promise.race([
      client.exited,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("First RPC child did not exit after stdin close")), PROCESS_EXIT_TIMEOUT_MS)),
    ]);
    assert(firstExit.code === 0, `First RPC child exited unsuccessfully: ${JSON.stringify(firstExit)}\nstderr:\n${client.stderr}`);

    const resumed = new RpcSpikeClient(command.executable, [...command.argsPrefix, ...args, "--session", sessionFile], {
      cwd: worktree,
      env: environment,
      absoluteDeadlineMs,
    });
    try {
      const resumedState = responseData(await resumed.send({ type: "get_state" }));
      assert(resumedState.sessionId === sessionId, "Resumed RPC child loaded a different session ID");
      assert(resumedState.sessionFile === sessionFile, "Resumed RPC child loaded a different session file");
      assert((await realpath(worktree)) === canonicalWorktree, "Resumed RPC child did not use the same worktree");
      assert(typeof resumedState.messageCount === "number" && resumedState.messageCount > 0, "Resumed RPC session lost its messages");
      const resumeStart = resumed.checkpoint();
      await resumed.send({ type: "prompt", message: "PI_LOOPS_SPIKE_COMPLETE_AFTER_RESUME" });
      await resumed.waitFor(isType("agent_settled"), { after: resumeStart, timeoutMs: EVENT_TIMEOUT_MS });
    } finally {
      await resumed.stop();
    }

    return {
      platform: process.platform,
      executable: command.executable,
      executableName: basename(command.executable),
      piVersion: command.version,
      worktree: "isolated temporary Git worktree",
      currentPiExecutableResolution: "passed",
      controlledPromptAndSettled: "passed",
      streamingAbort: "passed",
      modelToolAbortAndDescendantCleanup: "passed",
      extensionUiRelay: "passed",
      sameWorktreeSessionResume: "passed",
    };
  } finally {
    await client.stop().catch(() => undefined);
    await removeTemporaryRoot(root);
  }
}

interface ParentState {
  readonly phase: "ready" | "stopped" | "failed";
  readonly helperPid?: number;
  readonly piPid?: number;
  readonly parentPid?: number;
  readonly childPid?: number;
  readonly deadlineMs?: number;
  readonly error?: string;
}

async function waitForParentState(path: string, phase: ParentState["phase"], timeoutMs: number): Promise<ParentState> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = JSON.parse(await readFile(path, "utf8")) as ParentState;
      if (state.phase === "failed") throw new Error(`Lifecycle parent helper failed: ${state.error ?? "unknown error"}`);
      if (state.phase === phase) return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  throw new Error(`Timed out waiting for parent helper state ${phase}: ${path}`);
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => rejectExit(new Error(`Process ${child.pid ?? "unknown"} did not exit within ${timeoutMs}ms`)), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectExit(error);
    });
  });
}

type ParentTermination = "normal" | "SIGINT" | "SIGTERM" | "SIGKILL";

function processCommandLine(pid: number): string {
  if (process.platform === "win32") {
    return run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\").CommandLine`,
    ]);
  }
  return run("ps", ["-p", String(pid), "-o", "command="]);
}

async function runParentScenario(
  command: PiCommand,
  termination: ParentTermination,
  iteration: number,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `pi-loops-parent-${termination.toLowerCase()}-`));
  const stateFile = join(root, "parent-state.json");
  const pidFile = join(root, "descendants.json");
  const sentinelStatusFile = join(root, "sentinel-status.json");
  const sessionDirectory = join(root, "sessions");
  const helperPath = resolve("scripts/fixtures/rpc-lifecycle-parent.ts");
  const { worktree } = await createWorktree(root);
  const forced = termination === "SIGKILL";
  const forcedDeadlineMs = process.platform === "win32" ? 20_000 : 4_000;
  const deadlineMs = Date.now() + (forced ? forcedDeadlineMs : 30_000);
  const helper = spawn(process.execPath, [
    helperPath,
    command.executable,
    JSON.stringify(command.argsPrefix),
    worktree,
    sessionDirectory,
    stateFile,
    pidFile,
    String(deadlineMs),
    sentinelStatusFile,
  ], {
    cwd: process.cwd(),
    shell: false,
    stdio: ["pipe", "ignore", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  helper.stderr?.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-64 * 1024);
  });

  try {
    const state = await waitForParentState(stateFile, "ready", process.platform === "win32" ? 30_000 : 20_000);
    const piPid = state.piPid;
    const parentPid = state.parentPid;
    const childPid = state.childPid;
    assert(
      typeof piPid === "number" && Number.isSafeInteger(piPid) &&
      typeof parentPid === "number" && Number.isSafeInteger(parentPid) &&
      typeof childPid === "number" && Number.isSafeInteger(childPid),
      `Parent helper returned invalid PIDs: ${JSON.stringify(state)}`,
    );
    assert(!processCommandLine(piPid).includes("PI_LOOPS_SPIKE_TOOL"), "Task prompt leaked into the Pi child process arguments");

    if (termination === "normal") {
      helper.stdin?.end("shutdown\n");
    } else {
      assert(helper.kill(termination), `Could not send ${termination} to lifecycle parent helper`);
    }
    const helperExit = await waitForChildExit(helper, forced ? 5_000 : 10_000);
    if (forced && process.platform !== "win32") {
      assert(helperExit.signal === "SIGKILL", `Forced parent exited unexpectedly: ${JSON.stringify(helperExit)} stderr=${stderr}`);
    } else if (!forced) {
      assert(helperExit.code === 0, `${termination} parent shutdown failed: ${JSON.stringify(helperExit)} stderr=${stderr}`);
    }

    const cleanupTimeoutMs = forced ? Math.max(1_000, deadlineMs - Date.now() + 4_000) : 5_000;
    await Promise.all([
      waitForProcessExit(piPid, cleanupTimeoutMs),
      waitForProcessExit(parentPid, cleanupTimeoutMs),
      waitForProcessExit(childPid, cleanupTimeoutMs),
    ]);
  } finally {
    if (helper.exitCode === null && helper.signalCode === null) helper.kill("SIGKILL");
    try {
      await removeTemporaryRoot(root);
    } catch (error) {
      const sentinelStatus = await readFile(sentinelStatusFile, "utf8").catch((statusError: NodeJS.ErrnoException) =>
        `unavailable:${statusError.code ?? statusError.message}`);
      throw new Error(`Lifecycle cleanup failed; sentinel=${sentinelStatus}`, { cause: error });
    }
  }

  if (forced) process.stdout.write(`forced-parent-death ${iteration}/10 passed\n`);
}

async function runParentLifecycleScenarios(command: PiCommand): Promise<Record<string, unknown>> {
  if (process.platform === "win32") {
    await runParentScenario(command, "normal", 1);
  } else {
    await runParentScenario(command, "SIGINT", 1);
    await runParentScenario(command, "SIGTERM", 1);
  }
  for (let iteration = 1; iteration <= 10; iteration += 1) {
    await runParentScenario(command, "SIGKILL", iteration);
  }
  return process.platform === "win32" ? {
    parentNormalShutdownCleanup: "passed",
    forcedParentDeathDeadlineCleanup: "passed 10/10",
  } : {
    parentSigintCleanup: "passed",
    parentSigtermCleanup: "passed",
    forcedParentDeathDeadlineCleanup: "passed 10/10",
  };
}

const command = await resolvePiCommand();
const lifecycle = await runLifecycleScenarios(command);
const parentLifecycle = await runParentLifecycleScenarios(command);
console.log(JSON.stringify({ ...lifecycle, ...parentLifecycle }, null, 2));
