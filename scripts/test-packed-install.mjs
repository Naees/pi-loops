#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { findForbiddenPackagePaths, findMissingPackagePaths, REQUIRED_PACKAGE_PATHS } from "./package-boundary.mjs";

const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-loops-packed-"));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    shell: false,
    maxBuffer: 2 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result;
}

async function runPackedStatus(piExecutable, extensionPath, cwd, environment) {
  const child = spawn(
    piExecutable,
    ["--mode", "rpc", "--no-session", "--no-extensions", "--extension", extensionPath],
    { cwd, env: environment, stdio: ["pipe", "pipe", "pipe"], shell: false },
  );
  let buffer = "";
  let stderr = "";
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));

  const notificationPromise = new Promise((resolveNotification, rejectNotification) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      rejectNotification(new Error(`Packed /loops status timed out\nstderr:\n${stderr}`));
    }, 15_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectNotification(error);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-64 * 1024);
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (
          message.type === "extension_ui_request" &&
          message.method === "notify" &&
          message.message === "No Pi Loops goal runs are stored for this project."
        ) {
          clearTimeout(timer);
          child.stdin.end();
          resolveNotification(message);
          return;
        }
      }
    });
  });
  child.stdin.write(`${JSON.stringify({ id: "status", type: "prompt", message: "/loops status" })}\n`);
  const notification = await notificationPromise;
  if (!notification) throw new Error("Packed /loops status returned no notification");
  await exited;
}

try {
  const pack = run("npm", ["pack", "--json", "--pack-destination", temporaryRoot]);
  const report = JSON.parse(pack.stdout)[0];
  if (!report?.filename || !Array.isArray(report.files)) throw new Error("npm pack returned an invalid report");

  const forbidden = findForbiddenPackagePaths(report.files);
  if (forbidden.length > 0) throw new Error(`Packed forbidden files: ${forbidden.join(", ")}`);
  const missing = findMissingPackagePaths(report.files);
  if (missing.length > 0) throw new Error(`Packed required files are missing: ${missing.join(", ")}`);

  const tarball = join(temporaryRoot, report.filename);
  const installRoot = join(temporaryRoot, "install");
  run("npm", ["install", "--prefix", installRoot, "--ignore-scripts", "--no-audit", "--no-fund", tarball]);

  const packageRoot = join(installRoot, "node_modules", "@naees", "pi-loops");
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  if (manifest.name !== "@naees/pi-loops") throw new Error("Installed package identity is incorrect");
  if (manifest.publishConfig?.access !== "public" || manifest.publishConfig?.provenance !== true) {
    throw new Error("Installed package does not preserve public provenance publishing policy");
  }
  if (!Array.isArray(manifest.pi?.skills) || !manifest.pi.skills.includes("./skills")) {
    throw new Error("Installed package does not expose the pi-loops skill");
  }
  await Promise.all(REQUIRED_PACKAGE_PATHS.map((path) => readFile(join(packageRoot, path), "utf8")));

  const extensionPath = join(packageRoot, "src", "extension", "index.ts");
  const piExecutable = process.env.PI_LOOPS_TEST_PI ?? "pi";
  const rpc = run(
    piExecutable,
    ["--mode", "rpc", "--no-session", "--no-extensions", "--extension", extensionPath],
    {
      cwd: resolve(temporaryRoot),
      input: `${JSON.stringify({ id: "commands", type: "get_commands" })}\n`,
      env: { ...process.env, PI_CODING_AGENT_DIR: join(temporaryRoot, "pi-home") },
    },
  );

  const messages = rpc.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const response = messages.find((message) => message.id === "commands" && message.type === "response");
  if (!response?.success) throw new Error("Packed extension did not answer get_commands successfully");
  if (!response.data.commands.some((command) => command.name === "loops" && command.source === "extension")) {
    throw new Error("Packed extension did not register /loops");
  }
  await runPackedStatus(
    piExecutable,
    extensionPath,
    resolve(temporaryRoot),
    { ...process.env, PI_CODING_AGENT_DIR: join(temporaryRoot, "pi-home-status") },
  );

  console.log(`Packed install passed: ${report.files.length} files; /loops loaded and status executed from ${extensionPath}`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
