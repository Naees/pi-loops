#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { lstat, mkdir, readFile, readlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  findPotentialSecrets,
  findUnpinnedGitHubActions,
  validateAuditReport,
  validateCycloneDxSbom,
} from "./security-policy.mjs";
import { npmInvocation } from "./platform-command.mjs";

const MAX_COMMAND_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_SCANNED_FILE_BYTES = 4 * 1024 * 1024;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    shell: false,
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    ...options,
  });
  if (result.error) throw result.error;
  return result;
}

function parseJsonOutput(label, result) {
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON${result.stderr ? `: ${result.stderr.trim()}` : ""}`, { cause: error });
  }
}

function sbomOutputPath(args) {
  if (args.length === 0) return undefined;
  if (args.length !== 2 || args[0] !== "--sbom" || !args[1]) {
    throw new Error("Usage: node scripts/security-check.mjs [--sbom <output-path>]");
  }
  return resolve(args[1]);
}

const outputPath = sbomOutputPath(process.argv.slice(2));
const auditCommand = npmInvocation(["audit", "--omit=dev", "--audit-level=high", "--json"]);
const auditResult = run(auditCommand.executable, auditCommand.args);
const auditCounts = validateAuditReport(parseJsonOutput("npm audit", auditResult));
if (auditResult.status !== 0) {
  throw new Error(`npm audit failed with exit status ${String(auditResult.status)} after policy validation`);
}

const sbomCommand = npmInvocation(["sbom", "--omit=dev", "--sbom-format=cyclonedx"]);
const sbomResult = run(sbomCommand.executable, sbomCommand.args);
if (sbomResult.status !== 0) {
  throw new Error(`npm sbom failed\n${sbomResult.stderr || sbomResult.stdout}`);
}
const sbom = parseJsonOutput("npm sbom", sbomResult);
const inventory = validateCycloneDxSbom(sbom);
if (outputPath) {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(sbom, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

const filesResult = run("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
if (filesResult.status !== 0) throw new Error(`git ls-files failed\n${filesResult.stderr}`);
const entries = [];
for (const path of filesResult.stdout.split("\0").filter(Boolean)) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") continue;
    throw error;
  }
  if (metadata.isSymbolicLink()) {
    entries.push({ path, text: await readlink(path) });
    continue;
  }
  if (!metadata.isFile()) continue;
  if (metadata.size > MAX_SCANNED_FILE_BYTES) {
    throw new Error(`Tracked secret scan requires manual review for oversized file: ${path}`);
  }
  const contents = await readFile(path);
  if (contents.includes(0)) continue;
  entries.push({ path, text: contents.toString("utf8") });
}
const secrets = findPotentialSecrets(entries);
if (secrets.length > 0) {
  throw new Error(`Potential committed secrets detected:\n${secrets.map(({ path, kind }) => `${path}: ${kind}`).join("\n")}`);
}
const unpinnedActions = findUnpinnedGitHubActions(entries);
if (unpinnedActions.length > 0) {
  throw new Error(`GitHub Actions must use immutable commit SHAs:\n${unpinnedActions.map(({ path, line, uses }) => `${path}:${line}: ${uses}`).join("\n")}`);
}

console.log(`Security checks passed: ${auditCounts.total} audited vulnerabilities; ${inventory.length} production dependencies; licenses ${[...new Set(inventory.flatMap((entry) => entry.licenses))].sort().join(", ")}; ${entries.length} files scanned${outputPath ? `; SBOM written to ${outputPath}` : ""}.`);
