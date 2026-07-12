#!/usr/bin/env node

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, resolve } from "node:path";
import { RpcJsonlDecoder } from "../src/worker/rpc-jsonl.ts";

const RPC_TIMEOUT_MS = 10_000;
const EXIT_TIMEOUT_MS = 5_000;
const TERMINATE_TIMEOUT_MS = 2_000;
const MAX_STDERR_BYTES = 64 * 1024;

interface RpcResponse {
  readonly id: string;
  readonly type: "response";
  readonly success: boolean;
  readonly command: string;
  readonly data?: unknown;
  readonly error?: string;
}

interface PendingRequest {
  readonly command: string;
  readonly resolve: (response: RpcResponse) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseResponse(value: unknown): RpcResponse | undefined {
  if (!isRecord(value) || value.type !== "response" || typeof value.id !== "string") return undefined;
  if (typeof value.success !== "boolean" || typeof value.command !== "string") {
    throw new Error("RPC response has an invalid shape");
  }
  return value as unknown as RpcResponse;
}

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
  env: {
    ...process.env,
    PI_LOOPS_CHILD: runToken,
    PI_LOOPS_CHILD_DEADLINE_MS: String(Date.now() + 60_000),
  },
});
const exited = exitPromise(child);
const decoder = new RpcJsonlDecoder({ maxLineBytes: 1024 * 1024 });
const pending = new Map<string, PendingRequest>();
let stderr = "";
let streamFailure: Error | undefined;

function rejectPending(error: Error): void {
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(error);
  }
  pending.clear();
}

function send(command: Record<string, unknown>, timeoutMs = RPC_TIMEOUT_MS): Promise<RpcResponse> {
  const id = command.id;
  if (typeof id !== "string" || id.length === 0) throw new Error("RPC spike commands require an ID");
  if (pending.has(id)) throw new Error(`Duplicate RPC request ID: ${id}`);

  const commandType = command.type;
  if (typeof commandType !== "string" || commandType.length === 0) throw new Error("RPC spike commands require a type");

  return new Promise((resolveRequest, rejectRequest) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      rejectRequest(new Error(`RPC request timed out: ${id}`));
    }, timeoutMs);
    pending.set(id, { command: commandType, resolve: resolveRequest, reject: rejectRequest, timer });
    child.stdin.write(`${JSON.stringify(command)}\n`, (error) => {
      if (!error) return;
      clearTimeout(timer);
      pending.delete(id);
      rejectRequest(error);
    });
  });
}

child.stdout.on("data", (chunk: Buffer) => {
  if (streamFailure) return;
  try {
    for (const message of decoder.push(chunk)) {
      const response = parseResponse(message);
      if (!response) continue;
      const request = pending.get(response.id);
      if (!request) continue;
      if (response.command !== request.command) {
        throw new Error(`RPC response command mismatch for ${response.id}: expected ${request.command}, received ${response.command}`);
      }
      clearTimeout(request.timer);
      pending.delete(response.id);
      request.resolve(response);
    }
  } catch (error) {
    streamFailure = error instanceof Error ? error : new Error(String(error));
    rejectPending(streamFailure);
    child.kill("SIGTERM");
  }
});

child.stderr.on("data", (chunk: Buffer) => {
  if (streamFailure) return;
  stderr += chunk.toString("utf8");
  if (Buffer.byteLength(stderr, "utf8") > MAX_STDERR_BYTES) {
    streamFailure = new Error(`RPC stderr exceeded ${MAX_STDERR_BYTES} bytes`);
    rejectPending(streamFailure);
    child.kill("SIGTERM");
  }
});
void exited.then((result) => {
  if (pending.size > 0) {
    rejectPending(new Error(`RPC child exited with pending requests: ${JSON.stringify(result)}`));
  }
});

try {
  const state = await send({ id: "state", type: "get_state" });
  if (!state.success) throw new Error(`RPC state handshake failed: ${state.error ?? "unknown error"}`);

  const bashResultPromise = send(
    { id: "long-bash", type: "bash", command: 'node -e "setTimeout(() => {}, 30000)"' },
    15_000,
  );
  await delay(300);
  const abortResult = await send({ id: "abort-bash", type: "abort_bash" });
  if (!abortResult.success) throw new Error(`abort_bash failed: ${abortResult.error ?? "unknown error"}`);

  const bashResult = await bashResultPromise;
  if (!bashResult.success || !isRecord(bashResult.data) || bashResult.data.cancelled !== true) {
    throw new Error(`Long bash command was not reported as cancelled: ${JSON.stringify(bashResult)}`);
  }

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
    activeBashAbort: "passed",
    stdinCloseExit: "passed",
    exit: normalExit,
  }, null, 2));
} catch (error) {
  rejectPending(error instanceof Error ? error : new Error(String(error)));
  await terminate(child, exited);
  throw error;
}
