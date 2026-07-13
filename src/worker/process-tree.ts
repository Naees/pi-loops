import { spawn } from "node:child_process";
import { isAbsolute, join } from "node:path";

const TASKKILL_TIMEOUT_MS = 10_000;

export interface ProcessTreeTerminationOptions {
  readonly force?: boolean;
  readonly platform?: NodeJS.Platform;
  readonly environment?: NodeJS.ProcessEnv;
  readonly kill?: typeof process.kill;
  readonly spawn?: typeof import("node:child_process").spawn;
}

function positivePid(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Process tree termination requires a positive safe PID");
}

export function resolveWindowsTaskkill(environment: NodeJS.ProcessEnv = process.env): string {
  const systemRoot = environment.SystemRoot ?? environment.SYSTEMROOT ?? environment.windir ?? environment.WINDIR;
  if (!systemRoot || !isAbsolute(systemRoot)) throw new Error("Windows process-tree termination requires an absolute system root");
  return join(systemRoot, "System32", "taskkill.exe");
}

function runTaskkill(
  executable: string,
  args: readonly string[],
  implementation: typeof import("node:child_process").spawn,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = implementation(executable, [...args], {
      stdio: "ignore",
      shell: false,
      detached: true,
      timeout: TASKKILL_TIMEOUT_MS,
      windowsHide: true,
    });
    let settled = false;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      operation();
    };
    child.once("error", (error) => finish(() => reject(error)));
    child.once("exit", (code, signal) => finish(() => {
      if (code === 0) resolve();
      else reject(new Error(`taskkill failed: ${JSON.stringify({ code, signal })}`));
    }));
  });
}

export async function terminateProcessTree(pid: number, options: ProcessTreeTerminationOptions = {}): Promise<void> {
  positivePid(pid);
  const platform = options.platform ?? process.platform;
  const force = options.force ?? false;
  if (platform === "win32") {
    const args = ["/T", "/PID", String(pid), ...(force ? ["/F"] : [])];
    await runTaskkill(
      resolveWindowsTaskkill(options.environment),
      args,
      options.spawn ?? spawn,
    );
    return;
  }

  const signal: NodeJS.Signals = force ? "SIGKILL" : "SIGTERM";
  const kill = options.kill ?? process.kill;
  try {
    kill(-pid, signal);
  } catch {
    try {
      kill(pid, signal);
    } catch (processError) {
      const code = (processError as NodeJS.ErrnoException).code;
      if (code !== "ESRCH") throw processError;
    }
  }
}
