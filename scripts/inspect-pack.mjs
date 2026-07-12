#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { findForbiddenPackagePaths } from "./package-boundary.mjs";

const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
  encoding: "utf8",
  shell: false,
});

if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout);
  process.exit(result.status ?? 1);
}

const reports = JSON.parse(result.stdout);
const report = reports[0];
if (!report || !Array.isArray(report.files)) {
  throw new Error("npm pack did not return a file inventory");
}

const paths = report.files.map((file) => file.path);
const forbidden = findForbiddenPackagePaths(paths);

if (forbidden.length > 0) {
  throw new Error(`Forbidden npm package files:\n${forbidden.join("\n")}`);
}

console.log(`Package inspection passed: ${paths.length} files, ${report.unpackedSize} bytes unpacked.`);
