#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const root = await mkdtemp(join(tmpdir(), "pi-loops-packed-state-"));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    shell: false,
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\nstdout:\n${result.stdout ?? ""}\nstderr:\n${result.stderr ?? ""}`);
  }
  return result;
}

async function snapshot(directory) {
  const entries = new Map();
  const visit = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const digest = createHash("sha256").update(await readFile(path)).digest("hex");
        entries.set(relative(directory, path), digest);
      } else {
        throw new Error(`Unexpected state entry type: ${path}`);
      }
    }
  };
  await visit(directory);
  return [...entries].sort(([left], [right]) => left.localeCompare(right));
}

try {
  const packed = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", root]).stdout)[0];
  if (!packed?.filename) throw new Error("npm pack returned no release-candidate filename");
  const tarball = join(root, packed.filename);
  const installRoot = join(root, "install");
  const dataRoot = join(root, "pi-home", "pi-loops");
  const projectDirectory = join(root, "project");
  await mkdir(projectDirectory, { recursive: true });
  const projectRoot = await realpath(projectDirectory);
  const packageRoot = join(installRoot, "node_modules", "@naees", "pi-loops");
  const fixturesRoot = join(process.cwd(), "tests", "fixtures", "state-v1");
  const vitest = join(process.cwd(), "node_modules", ".bin", "vitest");

  const install = () => run("npm", ["install", "--prefix", installRoot, "--ignore-scripts", "--no-audit", "--no-fund", tarball]);
  const verify = (seed) => run(vitest, ["run", "--config", "scripts/vitest.packed-state.config.ts", "--reporter=dot"], {
    stdio: "inherit",
    env: {
      ...process.env,
      PI_LOOPS_PACKED_ROOT: packageRoot,
      PI_LOOPS_STATE_DATA_ROOT: dataRoot,
      PI_LOOPS_STATE_PROJECT_ROOT: projectRoot,
      PI_LOOPS_STATE_FIXTURES_ROOT: fixturesRoot,
      PI_LOOPS_STATE_SEED: seed ? "1" : "0",
    },
  });

  install();
  verify(true);
  const originalState = await snapshot(dataRoot);
  if (originalState.length !== 7) throw new Error(`Expected seven frozen state files, found ${originalState.length}`);

  install();
  verify(false);
  if (JSON.stringify(await snapshot(dataRoot)) !== JSON.stringify(originalState)) {
    throw new Error("In-place packed upgrade changed version-one runtime state");
  }

  run("npm", ["uninstall", "--prefix", installRoot, "--ignore-scripts", "--no-audit", "--no-fund", "@naees/pi-loops"]);
  await access(packageRoot).then(
    () => { throw new Error("npm uninstall left Pi Loops package files installed"); },
    (error) => {
      if (error?.code !== "ENOENT") throw error;
    },
  );
  if (JSON.stringify(await snapshot(dataRoot)) !== JSON.stringify(originalState)) {
    throw new Error("Package uninstall changed user runtime state");
  }

  install();
  verify(false);
  if (JSON.stringify(await snapshot(dataRoot)) !== JSON.stringify(originalState)) {
    throw new Error("Reinstall changed version-one runtime state");
  }

  console.log("Packed state compatibility passed: version-one state survived upgrade, uninstall, and reinstall without rewriting.");
} finally {
  await rm(root, { recursive: true, force: true });
}
