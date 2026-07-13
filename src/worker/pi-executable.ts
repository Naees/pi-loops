import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { basename, dirname, join, normalize } from "node:path";
import { errorMessage } from "../shared/errors.js";
import { readBoundedJsonFile } from "../storage/json-record-files.js";

const VERSION_TIMEOUT_MS = 5_000;
const MAX_VERSION_OUTPUT_BYTES = 16 * 1024;
const MAX_PACKAGE_MANIFEST_BYTES = 256 * 1024;
const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const PI_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export interface PiLaunchCommand {
  readonly executable: string;
  readonly argsPrefix: readonly string[];
  readonly version: string;
  readonly source: "current-node-cli" | "current-binary";
}

export interface PiExecutableResolutionOptions {
  readonly execPath?: string;
  readonly argv?: readonly string[];
  readonly probeVersion?: (executable: string, argsPrefix: readonly string[]) => Promise<string>;
  readonly versionProbeTimeoutMs?: number;
}

interface LaunchCandidate {
  readonly executable: string;
  readonly argsPrefix: readonly string[];
  readonly source: PiLaunchCommand["source"];
}

function isLikelyPiCliPath(path: string): boolean {
  const normalized = normalize(path).replaceAll("\\", "/").toLowerCase();
  return normalized.endsWith("/dist/cli.js") && normalized.includes("/pi-coding-agent/");
}

function isLikelyPiBinary(path: string): boolean {
  const name = basename(path).toLowerCase();
  return name === "pi" || name === "pi.exe";
}

async function defaultProbeVersion(
  executable: string,
  argsPrefix: readonly string[],
  timeoutMs = VERSION_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...argsPrefix, "--version"], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      operation();
    };
    const append = (current: Buffer, chunk: Buffer): Buffer => {
      if (settled) return current;
      const combined = Buffer.concat([current, chunk]);
      if (combined.byteLength > MAX_VERSION_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(() => reject(new Error(`Pi version probe exceeds ${MAX_VERSION_OUTPUT_BYTES} bytes`)));
      }
      return combined.subarray(0, MAX_VERSION_OUTPUT_BYTES);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("exit", (code, signal) => {
      finish(() => {
        if (code !== 0) {
          reject(new Error(`Pi version probe failed: ${JSON.stringify({ code, signal })} ${stderr.toString("utf8").trim()}`));
          return;
        }
        resolve(stdout.toString("utf8").trim());
      });
    });
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error(`Pi version probe timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
  });
}

async function canonicalCandidate(candidate: LaunchCandidate): Promise<LaunchCandidate> {
  const executable = await realpath(candidate.executable);
  await access(executable, constants.X_OK);
  const argsPrefix = await Promise.all(candidate.argsPrefix.map(async (argument) => {
    const canonical = await realpath(argument);
    await access(canonical, constants.R_OK);
    return canonical;
  }));
  return { ...candidate, executable, argsPrefix };
}

async function validateNodeCliPackage(cliPath: string, version: string): Promise<void> {
  const manifestPath = join(dirname(cliPath), "..", "package.json");
  const manifest = await readBoundedJsonFile(
    manifestPath,
    MAX_PACKAGE_MANIFEST_BYTES,
    `Pi package manifest exceeds ${MAX_PACKAGE_MANIFEST_BYTES} bytes`,
  );
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    throw new Error("Pi package manifest must be an object");
  }
  const record = manifest as Record<string, unknown>;
  if (record.name !== PI_PACKAGE_NAME) throw new Error(`Unexpected Pi package identity: ${String(record.name)}`);
  if (record.version !== version) {
    throw new Error(`Pi package version ${String(record.version)} does not match executable version ${version}`);
  }
}

export async function resolveCurrentPiLaunchCommand(
  options: PiExecutableResolutionOptions = {},
): Promise<PiLaunchCommand> {
  const execPath = options.execPath ?? process.execPath;
  const argv = options.argv ?? process.argv;
  const probeTimeoutMs = options.versionProbeTimeoutMs ?? VERSION_TIMEOUT_MS;
  if (!Number.isSafeInteger(probeTimeoutMs) || probeTimeoutMs <= 0) {
    throw new Error("Pi version probe timeout must be a positive safe integer");
  }
  const probeVersion = options.probeVersion ?? ((executable, argsPrefix) => defaultProbeVersion(executable, argsPrefix, probeTimeoutMs));
  const candidates: LaunchCandidate[] = [];
  const currentScript = argv[1];

  if (currentScript && isLikelyPiCliPath(currentScript)) {
    candidates.push({ executable: execPath, argsPrefix: [currentScript], source: "current-node-cli" });
  }
  if (isLikelyPiBinary(execPath)) {
    candidates.push({ executable: execPath, argsPrefix: [], source: "current-binary" });
  }
  if (candidates.length === 0) {
    throw new Error("Could not identify the current Pi installation from process.execPath and process.argv[1]");
  }

  const failures: string[] = [];
  for (const candidate of candidates) {
    try {
      const canonical = await canonicalCandidate(candidate);
      const version = await probeVersion(canonical.executable, canonical.argsPrefix);
      if (!PI_VERSION_PATTERN.test(version)) throw new Error(`Unexpected version output: ${version}`);
      if (canonical.source === "current-node-cli") {
        const cliPath = canonical.argsPrefix[0];
        if (!cliPath) throw new Error("Current Node CLI candidate has no CLI path");
        await validateNodeCliPackage(cliPath, version);
      }
      return { ...canonical, version };
    } catch (error) {
      failures.push(`${candidate.source}: ${errorMessage(error)}`);
    }
  }
  throw new Error(`Could not validate the current Pi installation (${failures.join("; ")})`);
}
