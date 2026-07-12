#!/usr/bin/env node

import { spawn } from "node:child_process";
import { resolve } from "node:path";

const piExecutable = process.env.PI_LOOPS_TEST_PI ?? "pi";
const extensionPath = resolve("src/extension/index.ts");
const deadlineMs = Date.now() + 1_000;
const child = spawn(
  piExecutable,
  ["--mode", "rpc", "--no-session", "--extension", extensionPath],
  {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    detached: false,
    env: {
      ...process.env,
      PI_LOOPS_CHILD: "watchdog-spike",
      PI_LOOPS_CHILD_DEADLINE_MS: String(deadlineMs),
    },
  },
);

let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdout = `${stdout}${chunk}`.slice(-64 * 1024);
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr = `${stderr}${chunk}`.slice(-64 * 1024);
});
child.stdin.write(`${JSON.stringify({ id: "state", type: "get_state" })}\n`);

const result = await new Promise((resolveExit, rejectExit) => {
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    rejectExit(new Error(`Child watchdog did not stop Pi after its deadline\nstdout:\n${stdout}\nstderr:\n${stderr}`));
  }, 6_000);
  child.once("error", (error) => {
    clearTimeout(timer);
    rejectExit(error);
  });
  child.once("exit", (code, signal) => {
    clearTimeout(timer);
    resolveExit({ code, signal, elapsedMs: Date.now() - (deadlineMs - 1_000) });
  });
});

const expectedTermination = result.code === 0 || result.code === 143 || result.signal === "SIGTERM";
if (!expectedTermination) throw new Error(`Watchdog child exited unexpectedly: ${JSON.stringify(result)}\nstderr:\n${stderr}`);
if (result.elapsedMs < 900 || result.elapsedMs > 6_000) {
  throw new Error(`Watchdog child exited outside the expected window: ${JSON.stringify(result)}`);
}

console.log(JSON.stringify({ watchdogDeadline: "passed", exit: result }, null, 2));
