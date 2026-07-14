#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { findForbiddenPackagePaths, findMissingPackagePaths, packagePublishReport } from "./package-boundary.mjs";
import { npmInvocation } from "./platform-command.mjs";

const manifest = JSON.parse(await readFile("package.json", "utf8"));
if (manifest.name !== "@naees/pi-loops" || typeof manifest.version !== "string") {
  throw new Error("Release manifest identity is invalid");
}
if (manifest.publishConfig?.access !== "public" || manifest.publishConfig?.provenance !== true) {
  throw new Error("Release manifest must require public access and npm provenance");
}

const npm = npmInvocation(["publish", "--dry-run", "--json", "--access", "public"]);
const result = spawnSync(npm.executable, npm.args, {
  encoding: "utf8",
  shell: false,
  maxBuffer: 8 * 1024 * 1024,
});
if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error(`npm publish --dry-run failed\n${result.stderr || result.stdout}`);
}
let output;
try {
  output = JSON.parse(result.stdout);
} catch (error) {
  throw new Error("npm publish --dry-run returned invalid JSON", { cause: error });
}
const report = packagePublishReport(output, manifest.name);
if (!report || report.version !== manifest.version || report.id !== `${manifest.name}@${manifest.version}` ||
  !Array.isArray(report.files) || !Array.isArray(report.bundled)) {
  throw new Error("npm publish --dry-run returned an invalid package report");
}
const forbidden = findForbiddenPackagePaths(report.files);
if (forbidden.length > 0) throw new Error(`Publish dry-run contains forbidden files: ${forbidden.join(", ")}`);
const missing = findMissingPackagePaths(report.files);
if (missing.length > 0) throw new Error(`Publish dry-run is missing required file: ${missing[0]}`);
if (report.bundled.length > 0) throw new Error(`Publish dry-run unexpectedly bundles dependencies: ${report.bundled.join(", ")}`);

console.log(`Publish dry-run passed: ${report.id}; ${report.entryCount} files; ${report.size} packed bytes; public access with provenance required. No package was published.`);
