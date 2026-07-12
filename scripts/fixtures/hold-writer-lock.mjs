import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";

const path = process.argv[2];
if (!path) throw new Error("Writer lock path is required");
await mkdir(dirname(path), { recursive: true });
const release = await lockfile.lock(path, {
  realpath: false,
  stale: 30_000,
  update: 15_000,
  retries: 0,
});
process.stdout.write("ready\n");
process.stdin.resume();
process.stdin.once("end", async () => {
  await release();
  process.exit(0);
});
