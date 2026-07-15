#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findForbiddenPackagePaths, findMissingPackagePaths, packagePublishReport } from "./package-boundary.mjs";
import { npmInvocation } from "./platform-command.mjs";

const manifest = JSON.parse(await readFile("package.json", "utf8"));
if (manifest.name !== "@naees/pi-loops" || typeof manifest.version !== "string") {
  throw new Error("Release manifest identity is invalid");
}
if (manifest.publishConfig?.access !== "public" || manifest.publishConfig?.provenance !== true) {
  throw new Error("Release manifest must require public access and npm provenance");
}

const cache = await mkdtemp(join(tmpdir(), "pi-loops-release-dry-run-"));
const npm = npmInvocation(["pack", "--dry-run", "--json", "--cache", cache]);
let result;
try {
  result = spawnSync(npm.executable, npm.args, {
    encoding: "utf8",
    shell: false,
    maxBuffer: 8 * 1024 * 1024,
  });
} finally {
  await rm(cache, { recursive: true, force: true });
}
if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error(`npm pack --dry-run failed\n${result.stderr || result.stdout}`);
}
let output;
try {
  output = JSON.parse(result.stdout);
} catch (error) {
  throw new Error("npm pack --dry-run returned invalid JSON", { cause: error });
}
const report = packagePublishReport(output, manifest.name);
if (!report || report.version !== manifest.version || report.id !== `${manifest.name}@${manifest.version}` ||
  !Array.isArray(report.files) || !Array.isArray(report.bundled)) {
  throw new Error("npm pack --dry-run returned an invalid package report");
}
const forbidden = findForbiddenPackagePaths(report.files);
if (forbidden.length > 0) throw new Error(`Publish dry-run contains forbidden files: ${forbidden.join(", ")}`);
const missing = findMissingPackagePaths(report.files);
if (missing.length > 0) throw new Error(`Publish dry-run is missing required file: ${missing[0]}`);
if (report.bundled.length > 0) throw new Error(`Publish dry-run unexpectedly bundles dependencies: ${report.bundled.join(", ")}`);

console.log(`Publication artifact dry-run passed: ${report.id}; ${report.entryCount} files; ${report.size} packed bytes; public access with provenance required. No registry was contacted and no package was published.`);
