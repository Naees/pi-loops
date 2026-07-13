import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { terminateProcessTree } from "./process-tree.js";

export const CHILD_MARKER_ENV = "PI_LOOPS_CHILD";
export const CHILD_DEADLINE_ENV = "PI_LOOPS_CHILD_DEADLINE_MS";

export interface WorkerWatchdogOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly now?: () => number;
  readonly terminateSelf?: () => void;
  readonly gracefulShutdownMs?: number;
  readonly platform?: NodeJS.Platform;
}

export function parseChildDeadline(value: string | undefined, nowMs: number = Date.now()): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const deadlineMs = Number(value);
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= nowMs) return undefined;
  return deadlineMs;
}

export function registerWorkerWatchdog(pi: ExtensionAPI, options: WorkerWatchdogOptions = {}): void {
  const environment = options.environment ?? process.env;
  const now = options.now ?? Date.now;
  const terminateSelf = options.terminateSelf ?? (() => {
    void terminateProcessTree(process.pid, { force: true }).catch(() => {
      process.kill(process.pid, "SIGTERM");
    });
  });
  const gracefulShutdownMs = options.gracefulShutdownMs ?? 1_000;
  const platform = options.platform ?? process.platform;
  if (!Number.isSafeInteger(gracefulShutdownMs) || gracefulShutdownMs < 0) {
    throw new Error("gracefulShutdownMs must be a non-negative safe integer");
  }

  const deadlineMs = parseChildDeadline(environment[CHILD_DEADLINE_ENV], now());
  let deadlineTimer: NodeJS.Timeout | undefined;

  const stop = (ctx: Pick<ExtensionContext, "abort" | "shutdown" | "ui">, message: string): void => {
    ctx.ui.notify(message, "warning");
    ctx.abort();
    ctx.shutdown();
    // A Windows process can exit before a delayed taskkill snapshots its child
    // tree, leaving reparented descendants behind. Start the forced tree
    // termination while the Pi process is still known to exist.
    if (platform === "win32") {
      terminateSelf();
    } else {
      setTimeout(terminateSelf, gracefulShutdownMs);
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    if (deadlineMs === undefined) {
      stop(ctx, "Pi Loops child refused to run without a valid absolute deadline.");
      return;
    }

    const scheduleCheck = (): void => {
      const remainingMs = deadlineMs - now();
      if (remainingMs <= 0) {
        stop(ctx, "Pi Loops child reached its absolute deadline and is stopping.");
        return;
      }
      deadlineTimer = setTimeout(scheduleCheck, Math.min(remainingMs, 2_147_000_000));
    };
    scheduleCheck();
  });

  pi.on("session_shutdown", async () => {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    deadlineTimer = undefined;
  });
}
