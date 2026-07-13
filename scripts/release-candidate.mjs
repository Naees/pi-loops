#!/usr/bin/env node

import { spawnSync } from "node:child_process";

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
  ["npm", ["run", "check"]],
  ["npm", ["run", "test:coverage"]],
  ["npm", ["run", "security:check"]],
  ["npm", ["run", "pack:inspect"]],
  ["npm", ["run", "test:packed"]],
  ["npm", ["run", "test:packed:state"]],
  ["npm", ["run", "test:e2e:scheduled:packed"]],
  ["npm", ["run", "release:dry-run"]],
];
for (const [command, commandArgs] of required) run(command, commandArgs);

if (runtime) {
  for (const [command, commandArgs] of [
    ["npm", ["run", "test:e2e:attended"]],
    ["npm", ["run", "test:e2e:proactive:runtime"]],
    ["npm", ["run", "test:rpc:lifecycle:production"]],
  ]) run(command, commandArgs);
}

console.log(`Release-candidate checks passed${runtime ? " with authenticated macOS runtime gates" : " (runtime gates not requested)"}.`);
