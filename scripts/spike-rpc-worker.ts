#!/usr/bin/env node

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, resolve } from "node:path";
import { RpcJsonlDecoder } from "../src/worker/rpc-jsonl.ts";

const HANDSHAKE_TIMEOUT_MS = 10_000;
const EXIT_TIMEOUT_MS = 5_000;
const TERMINATE_TIMEOUT_MS = 2_000;
const MAX_STDERR_BYTES = 64 * 1024;

async function resolveSpikePiExecutable(): Promise<string> {
  const candidates: string[] = [];
  if (process.env.PI_LOOPS_SPIKE_PI) candidates.push(process.env.PI_LOOPS_SPIKE_PI);

  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const suffixes = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
    for (const suffix of suffixes) candidates.push(resolve(directory, `pi${suffix}`));
  }

  for (const candidate of candidates) {
    try {
      const canonical = await realpath(candidate);
      await access(canonical, constants.X_OK);
      const version = spawnSync(canonical, ["--version"], { encoding: "utf8", shell: false, timeout: 5_000 });
      if (version.status === 0 && /^\d+\.\d+\.\d+/.test(version.stdout.trim())) return canonical;
    } catch {
      // Continue to the next candidate.
    }
  }

  throw new Error("Could not resolve and validate a Pi executable for the RPC spike");
}

function delay(ms: number): Promise<"timeout"> {
  return new Promise((resolveDelay) => setTimeout(() => resolveDelay("timeout"), ms));
}

function exitPromise(child: ChildProcessWithoutNullStreams): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}

function isStateResponse(value: unknown): value is { id: "state"; type: "response"; success: true } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.id === "state" && record.type === "response" && record.success === true;
}

async function terminate(child: ChildProcessWithoutNullStreams, exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if ((await Promise.race([exited, delay(TERMINATE_TIMEOUT_MS)])) !== "timeout") return;
  child.kill("SIGKILL");
  if ((await Promise.race([exited, delay(TERMINATE_TIMEOUT_MS)])) === "timeout") {
    throw new Error("RPC child did not exit after SIGKILL");
  }
}

const executable = await resolveSpikePiExecutable();
const extensionPath = resolve("src/extension/index.ts");
await access(extensionPath);

const runToken = `spike_${randomUUID()}`;
const args = ["--mode", "rpc", "--no-session", "--extension", extensionPath];
const child = spawn(executable, args, {
  cwd: process.cwd(),
  shell: false,
  detached: false,
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, PI_LOOPS_CHILD: runToken },
});
const exited = exitPromise(child);
const decoder = new RpcJsonlDecoder({ maxLineBytes: 1024 * 1024 });
let stderr = "";
let streamFailure: Error | undefined;

let resolveHandshake: (() => void) | undefined;
const handshake = new Promise<void>((resolveHandshakePromise) => {
  resolveHandshake = resolveHandshakePromise;
});

child.stdout.on("data", (chunk: Buffer) => {
  if (streamFailure) return;
  try {
    for (const message of decoder.push(chunk)) {
      if (isStateResponse(message)) resolveHandshake?.();
    }
  } catch (error) {
    streamFailure = error instanceof Error ? error : new Error(String(error));
    child.kill("SIGTERM");
  }
});

child.stderr.on("data", (chunk: Buffer) => {
  if (streamFailure) return;
  stderr += chunk.toString("utf8");
  if (Buffer.byteLength(stderr, "utf8") > MAX_STDERR_BYTES) {
    streamFailure = new Error(`RPC stderr exceeded ${MAX_STDERR_BYTES} bytes`);
    child.kill("SIGTERM");
  }
});

child.stdin.write(`${JSON.stringify({ id: "state", type: "get_state" })}\n`);

try {
  const handshakeResult = await Promise.race([handshake.then(() => "passed" as const), delay(HANDSHAKE_TIMEOUT_MS)]);
  if (handshakeResult === "timeout") throw new Error(`RPC state handshake timed out. stderr=${stderr}`);
  if (streamFailure) throw streamFailure;

  child.stdin.end();
  const normalExit = await Promise.race([exited, delay(EXIT_TIMEOUT_MS)]);
  if (normalExit === "timeout") throw new Error("RPC child did not exit after stdin closed");
  if (normalExit.code !== 0) {
    throw new Error(`RPC child exited unsuccessfully: ${JSON.stringify(normalExit)} stderr=${stderr}`);
  }

  console.log(JSON.stringify({
    executable,
    args,
    runToken,
    handshake: "passed",
    stdinCloseExit: "passed",
    exit: normalExit,
  }, null, 2));
} catch (error) {
  await terminate(child, exited);
  throw error;
}
