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
// Win32 child processes can be reparented as soon as Pi begins its own
// deadline shutdown. Snapshot and terminate the intact tree first, while
// retaining the final second as the bounded shutdown margin.
const terminationAtMs = Math.max(Date.now(), absoluteDeadlineMs - 1_000);

while (targetExists(targetPid)) {
  const remainingMs = terminationAtMs - Date.now();
  if (remainingMs <= 0) {
    await terminateProcessTree(targetPid, { platform: "win32", force: true });
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, Math.min(remainingMs, 250)));
}
