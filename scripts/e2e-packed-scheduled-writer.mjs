#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localVitestInvocation, npmInvocation } from "./platform-command.mjs";

const root = await mkdtemp(join(tmpdir(), "pi-loops-packed-scheduled-e2e-"));
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", shell: false, stdio: options.stdio ?? "pipe", env: options.env ?? process.env });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  return result;
}
function runNpm(args) {
  const command = npmInvocation(args);
  return run(command.executable, command.args);
}

try {
  const packed = JSON.parse(runNpm(["pack", "--json", "--pack-destination", root]).stdout)[0];
  const install = join(root, "install");
  runNpm(["install", "--prefix", install, "--ignore-scripts", "--no-audit", "--no-fund", join(root, packed.filename)]);
  const packageRoot = join(install, "node_modules", "@naees", "pi-loops");
  const vitest = localVitestInvocation(["run", "--config", "scripts/vitest.packed-writer.config.ts", "--reporter=dot"]);
  run(vitest.executable, vitest.args, {
    stdio: "inherit",
    env: { ...process.env, PI_LOOPS_PACKED_ROOT: packageRoot },
  });
  console.log("Packed scheduled-writer E2E passed.");
} finally {
  await rm(root, { recursive: true, force: true });
}
