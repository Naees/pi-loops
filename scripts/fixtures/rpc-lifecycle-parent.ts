#!/usr/bin/env node

import { access, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { RpcSpikeClient, type RpcEnvelope } from "./rpc-spike-client.ts";

function requiredArgument(index: number): string {
  const value = process.argv[index + 2];
  if (!value) throw new Error("Usage: rpc-lifecycle-parent <executable> <args-prefix-json> <cwd> <session-dir> <state-file> <pid-file> <deadline-ms> <sentinel-status-file>");
  return value;
}

const executable = requiredArgument(0);
const parsedArgsPrefix = JSON.parse(requiredArgument(1)) as unknown;
if (!Array.isArray(parsedArgsPrefix) || !parsedArgsPrefix.every((value) => typeof value === "string")) {
  throw new Error("Parent helper requires a string launch-prefix array");
}
const argsPrefix = parsedArgsPrefix;
const cwd = requiredArgument(2);
const sessionDirectory = requiredArgument(3);
const stateFile = requiredArgument(4);
const pidFile = requiredArgument(5);
const deadlineMs = Number(requiredArgument(6));
const sentinelStatusFile = requiredArgument(7);
if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= Date.now()) throw new Error("Parent helper requires a future deadline");

const extensionPath = resolve("scripts/fixtures/rpc-lifecycle-extension.ts");
const watchdogPath = resolve("src/extension/index.ts");
const args = [
  "--mode", "rpc",
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--approve",
  "--extension", extensionPath,
  "--extension", watchdogPath,
  "--provider", "pi-loops-lifecycle",
  "--model", "controlled",
  "--session-dir", sessionDirectory,
];
const client = new RpcSpikeClient(executable, [...argsPrefix, ...args], {
  cwd,
  env: {
    ...process.env,
    PI_LOOPS_CHILD: "rpc-lifecycle-parent-helper",
    PI_LOOPS_CHILD_DEADLINE_MS: String(deadlineMs),
    PI_LOOPS_SPIKE_PID_FILE: pidFile,
  },
  absoluteDeadlineMs: deadlineMs,
  deadlineSentinelStatusPath: sentinelStatusFile,
});

let shuttingDown = false;
let keepAlive: NodeJS.Timeout | undefined;

function isSettled(message: RpcEnvelope): boolean {
  return message.type === "agent_settled";
}

async function waitForFile(path: string, timeoutMs = process.platform === "win32" ? 20_000 : 10_000): Promise<void> {
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
  throw new Error(`Timed out waiting for ${path}`);
}

async function shutdown(signal: "normal" | "SIGINT" | "SIGTERM"): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  if (keepAlive) clearInterval(keepAlive);
  try {
    const checkpoint = client.checkpoint();
    await client.send({ type: "abort" }, 5_000).catch(() => undefined);
    await client.waitFor(isSettled, { after: checkpoint, timeoutMs: 2_000 }).catch(() => undefined);
    await client.stop(1_000);
    await writeFile(stateFile, JSON.stringify({ phase: "stopped", signal, helperPid: process.pid }), "utf8");
    process.stdin.destroy();
    process.exitCode = 0;
  } catch (error) {
    await writeFile(stateFile, JSON.stringify({ phase: "failed", signal, error: error instanceof Error ? error.message : String(error) }), "utf8").catch(() => undefined);
    process.stdin.destroy();
    process.exitCode = 1;
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  if (chunk.split(/\r?\n/).includes("shutdown")) void shutdown("normal");
});

try {
  await client.send({ type: "get_state" });
  const checkpoint = client.checkpoint();
  const prompt = client.send({ type: "prompt", message: "PI_LOOPS_SPIKE_TOOL" });
  await client.waitFor((message) => message.type === "tool_execution_start" && message.toolName === "bash", {
    after: checkpoint,
    timeoutMs: 20_000,
  });
  await prompt;
  await waitForFile(pidFile);
  const descendants = JSON.parse(await readFile(pidFile, "utf8")) as { parentPid: number; childPid: number };
  await writeFile(stateFile, JSON.stringify({
    phase: "ready",
    helperPid: process.pid,
    piPid: client.child.pid,
    parentPid: descendants.parentPid,
    childPid: descendants.childPid,
    deadlineMs,
  }), "utf8");
  keepAlive = setInterval(() => undefined, 1_000);
} catch (error) {
  await writeFile(stateFile, JSON.stringify({ phase: "failed", error: error instanceof Error ? error.message : String(error) }), "utf8").catch(() => undefined);
  await client.stop().catch(() => undefined);
  process.exitCode = 1;
}
