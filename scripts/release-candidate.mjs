#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { npmInvocation } from "./platform-command.mjs";

const args = process.argv.slice(2);
const runtime = args.length === 1 && args[0] === "--runtime";
if (args.length > (runtime ? 1 : 0)) {
  throw new Error("Usage: node scripts/release-candidate.mjs [--runtime]");
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const required = [
  ["run", "check"],
  ["run", "test:coverage"],
  ["run", "security:check"],
  ["run", "pack:inspect"],
  ["run", "test:packed"],
  ["run", "test:packed:state"],
  ["run", "test:e2e:scheduled:packed"],
  ["run", "release:dry-run"],
];
for (const commandArgs of required) {
  const command = npmInvocation(commandArgs);
  run(command.executable, command.args);
}

if (runtime) {
  for (const commandArgs of [
    ["run", "test:e2e:attended"],
    ["run", "test:e2e:proactive:runtime"],
    ["run", "test:rpc:lifecycle:production"],
  ]) {
    const command = npmInvocation(commandArgs);
    run(command.executable, command.args);
  }
}

console.log(`Release-candidate checks passed${runtime ? " with authenticated macOS runtime gates" : " (runtime gates not requested)"}.`);
