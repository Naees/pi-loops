import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";

const path = process.argv[2];
if (!path) throw new Error("Trigger claim path is required");
await mkdir(dirname(path), { recursive: true });
const release = await lockfile.lock(path, {
  realpath: false,
  stale: 2_000,
  update: 1_000,
  retries: 0,
});
process.stdout.write("ready\n");
process.stdin.resume();
process.stdin.once("end", async () => {
  await release();
  process.exit(0);
});
