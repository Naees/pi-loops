import { writeFile } from "node:fs/promises";
import { terminateProcessTree } from "./process-tree.ts";

function positiveInteger(value: string | undefined, name: string): number {
  if (value === undefined || !/^\d+$/.test(value)) throw new Error(`${name} must be a positive safe integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive safe integer`);
  return parsed;
}

function targetExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

const targetPid = positiveInteger(process.argv[2], "target PID");
const absoluteDeadlineMs = positiveInteger(process.argv[3], "absolute deadline");
const statusPath = process.argv[4];
// Win32 child processes can be reparented as soon as Pi begins its own
// deadline shutdown. Snapshot and terminate the intact tree first, while
// retaining the final second as the bounded shutdown margin.
const terminationAtMs = Math.max(Date.now(), absoluteDeadlineMs - 1_000);

async function record(phase: string, detail?: string): Promise<void> {
  if (statusPath === undefined) return;
  await writeFile(statusPath, JSON.stringify({ phase, detail, sentinelPid: process.pid, targetPid, absoluteDeadlineMs, terminationAtMs }), "utf8");
}

try {
  await record("watching");
  let attemptedTermination = false;
  while (targetExists(targetPid)) {
    const remainingMs = terminationAtMs - Date.now();
    if (remainingMs <= 0) {
      attemptedTermination = true;
      await record("terminating");
      await terminateProcessTree(targetPid, { platform: "win32", force: true });
      await record("terminated");
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(remainingMs, 250)));
  }
  if (!attemptedTermination) await record("target-exited");
} catch (error) {
  await record("failed", error instanceof Error ? error.message : String(error)).catch(() => undefined);
  throw error;
}
