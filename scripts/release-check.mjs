#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

for (const path of [".project-design", ".pi-subagents"]) {
  if (existsSync(path)) {
    console.error(`Release blocked: ${path} exists in the release tree.`);
    process.exit(1);
  }
}

const status = spawnSync("git", ["status", "--porcelain"], { encoding: "utf8", shell: false });
if (status.error) throw status.error;
if (status.status !== 0) {
  process.stderr.write(status.stderr);
  process.exit(status.status ?? 1);
}
if (status.stdout.trim().length > 0) {
  console.error("Release blocked: the Git working tree is not clean.");
  process.exit(1);
}

const candidate = spawnSync(process.execPath, ["scripts/release-candidate.mjs", "--runtime"], {
  stdio: "inherit",
  shell: false,
});
if (candidate.error) throw candidate.error;
if (candidate.status !== 0) process.exit(candidate.status ?? 1);

console.log("Final release checks passed.");
