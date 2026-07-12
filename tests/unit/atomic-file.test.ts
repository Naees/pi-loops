import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

  it("never exposes partial JSON during concurrent replacements", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-loops-atomic-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "record.json");
    await Promise.all(Array.from({ length: 50 }, (_value, index) => writeJsonAtomic(path, {
      schemaVersion: 1,
      index,
      payload: "界".repeat(1_000),
    })));

    const stored = JSON.parse(await readFile(path, "utf8")) as { schemaVersion: number; index: number; payload: string };
    expect(stored.schemaVersion).toBe(1);
    expect(stored.index).toBeGreaterThanOrEqual(0);
    expect(stored.index).toBeLessThan(50);
    expect(stored.payload).toBe("界".repeat(1_000));
    expect((await readdir(directory)).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });
});
