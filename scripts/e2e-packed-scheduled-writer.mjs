#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "pi-loops-packed-scheduled-e2e-"));
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", shell: false, stdio: options.stdio ?? "pipe", env: options.env ?? process.env });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  return result;
}
try {
  const packed = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", root]).stdout)[0];
  const install = join(root, "install");
  run("npm", ["install", "--prefix", install, "--ignore-scripts", "--no-audit", "--no-fund", join(root, packed.filename)]);
  const packageRoot = join(install, "node_modules", "@naees", "pi-loops");
  run(join(process.cwd(), "node_modules", ".bin", "vitest"), ["run", "--config", "scripts/vitest.packed-writer.config.ts", "--reporter=dot"], {
    stdio: "inherit",
    env: { ...process.env, PI_LOOPS_PACKED_ROOT: packageRoot },
  });
  console.log("Packed scheduled-writer E2E passed.");
} finally {
  await rm(root, { recursive: true, force: true });
}
