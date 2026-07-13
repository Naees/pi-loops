#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

if (!(["darwin", "linux", "win32"].includes(process.platform))) {
  throw new Error(`Unsupported qualification platform: ${process.platform}`);
}

const result = spawnSync(process.execPath, [
  resolve("node_modules", "vitest", "vitest.mjs"),
  "run",
  "--config",
  "scripts/vitest.proactive.config.ts",
  "--reporter=dot",
], {
  stdio: "inherit",
  shell: false,
  env: { ...process.env, PI_LOOPS_QUALIFY_PLATFORM: process.platform },
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
