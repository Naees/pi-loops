#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { npmInvocation, piInvocation } from "./platform-command.mjs";

const sourcePiHome = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-loops-attended-e2e-"));
const temporaryPiHome = join(temporaryRoot, "pi-home");
const project = join(temporaryRoot, "project");
const piCommand = piInvocation();

function run(command, args) {
  const result = spawnSync(command, args, { cwd: process.cwd(), encoding: "utf8", shell: false, maxBuffer: 2 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  return result;
}

await mkdir(temporaryPiHome, { recursive: true, mode: 0o700 });
await mkdir(project, { mode: 0o700 });
await copyFile(join(sourcePiHome, "auth.json"), join(temporaryPiHome, "auth.json"));

function runNpm(args) {
  const command = npmInvocation(args);
  return run(command.executable, command.args);
}

const pack = JSON.parse(runNpm(["pack", "--json", "--pack-destination", temporaryRoot]).stdout)[0];
if (!pack?.filename) throw new Error("npm pack returned no tarball");
const installRoot = join(temporaryRoot, "install");
runNpm(["install", "--prefix", installRoot, "--ignore-scripts", "--no-audit", "--no-fund", join(temporaryRoot, pack.filename)]);
const packageRoot = join(installRoot, "node_modules", "@naees", "pi-loops");

const settings = JSON.parse(await readFile(join(sourcePiHome, "settings.json"), "utf8"));
settings.packages = [packageRoot];
await writeFile(join(temporaryPiHome, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });

const child = spawn(
  piCommand.executable,
  [...piCommand.argsPrefix, "--mode", "rpc", "--no-session"],
  {
    cwd: project,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    env: { ...process.env, PI_CODING_AGENT_DIR: temporaryPiHome },
  },
);

let buffer = "";
let stderr = "";
let terminalMessage;
let skillDiscovered = false;
const exited = new Promise((resolveExit) => child.once("exit", (code, signal) => resolveExit({ code, signal })));

try {
  terminalMessage = await new Promise((resolveTerminal, rejectTerminal) => {
    const timer = setTimeout(() => {
      child.stdin.write(`${JSON.stringify({ id: "stop", type: "prompt", message: "/loops stop" })}\n`);
      setTimeout(() => child.kill("SIGTERM"), 2_000).unref();
      rejectTerminal(new Error(`Attended goal E2E timed out\nstderr:\n${stderr}`));
    }, 120_000);

    child.once("error", (error) => {
      clearTimeout(timer);
      rejectTerminal(error);
    });
    child.once("exit", (code, signal) => {
      if (terminalMessage) return;
      clearTimeout(timer);
      rejectTerminal(new Error(`Pi exited before the goal completed: ${JSON.stringify({ code, signal })}\nstderr:\n${stderr}`));
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-64 * 1024);
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > 1024 * 1024) {
        clearTimeout(timer);
        child.kill("SIGTERM");
        rejectTerminal(new Error("Attended goal E2E received an oversized RPC line"));
        return;
      }
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.id === "commands" && message.type === "response" && message.success === true) {
          skillDiscovered = message.data.commands.some((command) => command.name === "skill:pi-loops");
          continue;
        }
        if (message.type !== "extension_ui_request" || message.method !== "notify" || typeof message.message !== "string") continue;
        if (/run_[0-9a-f]{8}: completed/.test(message.message)) {
          clearTimeout(timer);
          resolveTerminal(message.message);
          return;
        }
        if (/run_[0-9a-f]{8}: (failed|cancelled|stalled|budget_exhausted)/.test(message.message)) {
          clearTimeout(timer);
          rejectTerminal(new Error(`Attended goal ended unsuccessfully: ${message.message}`));
          return;
        }
      }
    });

    child.stdin.write(`${JSON.stringify({ id: "commands", type: "get_commands" })}\n`);
    child.stdin.write(`${JSON.stringify({
      id: "goal",
      type: "prompt",
      message: "Use the pi_loops tool to start an attended goal. Goal: do not create or modify files; run the exact verifier command and complete when it succeeds. verifierCommands: [node -e \"console.log('PHASE1_VERIFIER_OK')\"]. Use at most 3 cycles.",
    })}\n`);
  });

  child.stdin.end();
  await exited;
  if (!skillDiscovered) throw new Error("Packed Pi package did not expose the pi-loops skill");
  const projectFiles = await readdir(project);
  if (projectFiles.length > 0) throw new Error(`Attended read-only E2E modified the project: ${projectFiles.join(", ")}`);
  console.log(`Attended goal E2E passed: ${terminalMessage}`);
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  await rm(temporaryRoot, { recursive: true, force: true });
}
