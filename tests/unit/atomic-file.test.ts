import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeJsonAtomic } from "../../src/storage/atomic-file.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("atomic JSON files", () => {
  it("writes complete JSON through a same-directory replacement", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-loops-atomic-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "nested", "run.json");

    await writeJsonAtomic(path, { schemaVersion: 1, runId: "run_1234abcd" });

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ schemaVersion: 1, runId: "run_1234abcd" });
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  it("preserves the primary JSON when a subprocess is interrupted mid-replacement", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-loops-atomic-interrupt-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "record.json");
    const original = { schemaVersion: 1, value: "original" };
    await writeJsonAtomic(path, original);
    const source = [
      `import { writeJsonAtomic } from ${JSON.stringify(new URL("../../src/storage/atomic-file.ts", import.meta.url).href)};`,
      `await writeJsonAtomic(${JSON.stringify(path)}, { schemaVersion: 1, value: "x".repeat(128 * 1024 * 1024) });`,
    ].join("\n");
    const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", source], { stdio: "ignore" });
    await vi.waitFor(async () => {
      expect((await readdir(directory)).some((name) => /^\.record\.json\..+\.tmp$/.test(name))).toBe(true);
    }, { timeout: 5_000, interval: 5 });
    child.kill("SIGKILL");
    await once(child, "exit");

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(original);
  }, 10_000);

  it("never exposes partial JSON during concurrent replacements", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-loops-atomic-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "record.json");
    const payload = "界".repeat(1_000);
    await writeJsonAtomic(path, { schemaVersion: 1, index: -1, payload });

    let writesSettled = false;
    let reads = 0;
    const reader = (async () => {
      while (!writesSettled) {
        const observed = JSON.parse(await readFile(path, "utf8")) as { schemaVersion: number; index: number; payload: string };
        expect(observed.schemaVersion).toBe(1);
        expect(observed.index).toBeGreaterThanOrEqual(-1);
        expect(observed.index).toBeLessThan(50);
        expect(observed.payload).toBe(payload);
        reads += 1;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    })();
    await Promise.all(Array.from({ length: 50 }, (_value, index) => writeJsonAtomic(path, {
      schemaVersion: 1,
      index,
      payload,
    }))).finally(() => {
      writesSettled = true;
    });
    await reader;

    expect(reads).toBeGreaterThan(0);
    const stored = JSON.parse(await readFile(path, "utf8")) as { schemaVersion: number; index: number; payload: string };
    expect(stored.schemaVersion).toBe(1);
    expect(stored.index).toBeGreaterThanOrEqual(0);
    expect(stored.index).toBeLessThan(50);
    expect(stored.payload).toBe(payload);
    expect((await readdir(directory)).filter((name) => /^\.record\.json\..+\.tmp$/.test(name))).toEqual([]);
  });
});
