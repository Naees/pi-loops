#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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

try {
  const pack = run("npm", ["pack", "--json", "--pack-destination", temporaryRoot]);
  const report = JSON.parse(pack.stdout)[0];
  if (!report?.filename || !Array.isArray(report.files)) throw new Error("npm pack returned an invalid report");

  const forbidden = report.files
    .map((file) => file.path)
    .filter((path) => path.startsWith(".project-design/") || path.startsWith(".pi-subagents/") || path.startsWith("tests/"));
  if (forbidden.length > 0) throw new Error(`Packed forbidden files: ${forbidden.join(", ")}`);

  const tarball = join(temporaryRoot, report.filename);
  const installRoot = join(temporaryRoot, "install");
  run("npm", ["install", "--prefix", installRoot, "--ignore-scripts", "--no-audit", "--no-fund", tarball]);

  const packageRoot = join(installRoot, "node_modules", "@naees", "pi-loops");
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  if (manifest.name !== "@naees/pi-loops") throw new Error("Installed package identity is incorrect");

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

  console.log(`Packed install passed: ${report.files.length} files; /loops loaded from ${extensionPath}`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
