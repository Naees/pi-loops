import { spawn, type ChildProcess } from "node:child_process";
import { isAbsolute, win32 } from "node:path";
import { fileURLToPath } from "node:url";

const SENTINEL_READY_TIMEOUT_MS = 20_000;

export interface DeadlineSentinel {
  readonly ready: Promise<void>;
  stop(): void;
}

export interface DeadlineSentinelOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly spawn?: typeof spawn;
  readonly onError?: (error: Error) => void;
  readonly statusPath?: string;
}

function windowsSystemRoot(environment: NodeJS.ProcessEnv): string {
  const root = environment.SystemRoot ?? environment.SYSTEMROOT ?? environment.windir ?? environment.WINDIR;
  if (!root || !win32.isAbsolute(root)) throw new Error("Windows deadline sentinel requires an absolute system root");
  return root;
}

function safeWindowsEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {};
  for (const name of ["SystemRoot", "SYSTEMROOT", "windir", "WINDIR", "TEMP", "TMP"] as const) {
    const value = environment[name];
    if (value !== undefined) safe[name] = value;
  }
  return safe;
}

export function launchWindowsDeadlineSentinel(
  targetPid: number,
  absoluteDeadlineMs: number,
  options: DeadlineSentinelOptions = {},
): DeadlineSentinel {
  if (!Number.isSafeInteger(targetPid) || targetPid <= 0) throw new Error("Deadline sentinel requires a positive safe PID");
  if (!Number.isSafeInteger(absoluteDeadlineMs) || absoluteDeadlineMs <= Date.now()) {
    throw new Error("Deadline sentinel requires a future absolute deadline");
  }
  if (options.statusPath !== undefined && !isAbsolute(options.statusPath)) {
    throw new Error("Deadline sentinel status path must be absolute");
  }

  const environment = options.environment ?? process.env;
  const executable = win32.join(windowsSystemRoot(environment), "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = fileURLToPath(new URL("./windows-job-sentinel.ps1", import.meta.url));
  const implementation = options.spawn ?? spawn;
  const child: ChildProcess = implementation(executable, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", script,
    "-TargetProcessId", String(targetPid),
    "-AbsoluteDeadlineMs", String(absoluteDeadlineMs),
    ...(options.statusPath === undefined ? [] : ["-StatusPath", options.statusPath]),
  ], {
    detached: true,
    env: safeWindowsEnvironment(environment),
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stopped = false;
  let readySettled = false;
  let output = "";
  let stderr = "";
  let readyResolve: (() => void) | undefined;
  let readyReject: ((error: Error) => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const readyTimer = setTimeout(() => {
    if (readySettled || stopped) return;
    readySettled = true;
    const error = new Error(`Windows deadline sentinel did not become ready${stderr ? `: ${stderr}` : ""}`);
    readyReject?.(error);
    options.onError?.(error);
    child.kill();
  }, SENTINEL_READY_TIMEOUT_MS);
  readyTimer.unref();

  const report = (error: Error): void => {
    if (stopped) return;
    if (!readySettled) {
      readySettled = true;
      clearTimeout(readyTimer);
      readyReject?.(error);
    }
    options.onError?.(error);
  };
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-32 * 1024);
  });
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    if (readySettled) return;
    output += chunk;
    if (output.split(/\r?\n/).includes("PI_LOOPS_SENTINEL_READY")) {
      readySettled = true;
      clearTimeout(readyTimer);
      readyResolve?.();
    }
  });
  child.once("error", report);
  child.once("exit", (code, signal) => {
    if (code !== 0 && !stopped) {
      report(new Error(`Deadline sentinel exited unsuccessfully: ${JSON.stringify({ code, signal, stderr })}`));
    }
  });
  (child.stdout as (NodeJS.ReadableStream & { unref(): void }) | null)?.unref();
  (child.stderr as (NodeJS.ReadableStream & { unref(): void }) | null)?.unref();
  child.unref();

  return {
    ready,
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearTimeout(readyTimer);
      child.removeListener("error", report);
      if (!readySettled) {
        readySettled = true;
        readyResolve?.();
      }
      if (child.exitCode === null && child.signalCode === null) child.kill();
    },
  };
}
