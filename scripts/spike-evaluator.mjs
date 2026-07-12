#!/usr/bin/env node

import { spawn } from "node:child_process";
import { resolve } from "node:path";

const piExecutable = process.env.PI_LOOPS_TEST_PI ?? "pi";
const extensionPath = resolve(".project-design/spikes/evaluator-spike-extension.ts");
const child = spawn(
  piExecutable,
  ["--mode", "rpc", "--no-session", "--no-extensions", "--extension", extensionPath],
  {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  },
);

let stdoutBuffer = "";
let stderr = "";
let finished = false;
const maxLineBytes = 1024 * 1024;

const outcome = new Promise((resolveOutcome, rejectOutcome) => {
  const timer = setTimeout(() => {
    child.kill("SIGTERM");
    rejectOutcome(new Error(`Evaluator spike timed out\nstderr:\n${stderr}`));
  }, 60_000);

  child.once("error", (error) => {
    clearTimeout(timer);
    rejectOutcome(error);
  });
  child.once("exit", (code, signal) => {
    if (finished) return;
    clearTimeout(timer);
    rejectOutcome(new Error(`Evaluator spike exited before reporting: ${JSON.stringify({ code, signal })}\nstderr:\n${stderr}`));
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-64 * 1024);
  });

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    if (Buffer.byteLength(stdoutBuffer, "utf8") > maxLineBytes) {
      clearTimeout(timer);
      child.kill("SIGTERM");
      rejectOutcome(new Error(`Evaluator RPC line exceeded ${maxLineBytes} bytes`));
      return;
    }
    while (true) {
      const newline = stdoutBuffer.indexOf("\n");
      if (newline === -1) break;
      const line = stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line) continue;

      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        clearTimeout(timer);
        child.kill("SIGTERM");
        rejectOutcome(error);
        return;
      }

      if (
        message.type === "extension_ui_request" &&
        message.method === "notify" &&
        typeof message.message === "string" &&
        message.message.startsWith("PI_LOOPS_EVALUATOR_SPIKE_")
      ) {
        finished = true;
        clearTimeout(timer);
        child.stdin.end();
        resolveOutcome(message.message);
        return;
      }
    }
  });
});

child.stdin.write(`${JSON.stringify({ id: "evaluate", type: "prompt", message: "/pi-loops-evaluator-spike" })}\n`);
const message = await outcome;
if (!message.startsWith("PI_LOOPS_EVALUATOR_SPIKE_OK")) throw new Error(message);
console.log(message);
