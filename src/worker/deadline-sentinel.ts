import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface DeadlineSentinel {
  stop(): void;
}

export interface DeadlineSentinelOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly spawn?: typeof spawn;
  readonly onError?: (error: Error) => void;
}

function safeWindowsEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {};
  for (const name of ["SystemRoot", "SYSTEMROOT", "windir", "WINDIR"] as const) {
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

  const implementation = options.spawn ?? spawn;
  const script = fileURLToPath(new URL("./deadline-sentinel-child.ts", import.meta.url));
  const child: ChildProcess = implementation(process.execPath, [script, String(targetPid), String(absoluteDeadlineMs)], {
    detached: true,
    env: safeWindowsEnvironment(options.environment ?? process.env),
    shell: false,
    stdio: "ignore",
    windowsHide: true,
  });
  let stopped = false;
  const report = (error: Error): void => {
    if (!stopped) options.onError?.(error);
  };
  child.once("error", report);
  child.once("exit", (code, signal) => {
    if (code !== 0 && !stopped) {
      report(new Error(`Deadline sentinel exited unsuccessfully: ${JSON.stringify({ code, signal })}`));
    }
  });
  child.unref();

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      child.removeListener("error", report);
      if (child.exitCode === null && child.signalCode === null) child.kill();
    },
  };
}
