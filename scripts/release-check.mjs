#!/usr/bin/env node

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

for (const path of [".project-design", ".pi-subagents"]) {
  if (existsSync(path)) {
    console.error(`Release blocked: ${path} exists in the release tree.`);
    process.exit(1);
  }
}

for (const [command, args] of [
  ["npm", ["run", "check"]],
  ["npm", ["run", "pack:inspect"]],
]) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: false });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log("Release checks passed.");
