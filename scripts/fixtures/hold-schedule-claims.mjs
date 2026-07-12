import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";

const paths = process.argv.slice(2);
if (paths.length !== 2) throw new Error("Execution and occurrence claim paths are required");
const releases = [];
for (const path of paths) {
  await mkdir(dirname(path), { recursive: true });
  releases.push(await lockfile.lock(path, {
    realpath: false,
    stale: 2_000,
    update: 1_000,
    retries: 0,
  }));
}
process.stdout.write("ready\n");
process.stdin.resume();
process.stdin.once("end", async () => {
  for (const release of releases.reverse()) await release();
  process.exit(0);
});
