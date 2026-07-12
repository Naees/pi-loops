import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listRecordIds, readBoundedJsonFile } from "../../src/storage/json-record-files.js";

const temporary: string[] = [];
afterEach(async () => Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "pi-loops-json-records-"));
  temporary.push(path);
  return path;
}

describe("JSON record files", () => {
  it("reads bounded JSON and treats a missing file as absent", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "record.json");
    expect(await readBoundedJsonFile(path, 100, "too large")).toBeUndefined();
    await writeFile(path, '{"value":1}');
    expect(await readBoundedJsonFile(path, 100, "too large")).toEqual({ value: 1 });
    await expect(readBoundedJsonFile(path, 1, "too large")).rejects.toThrow("too large");
  });

  it("returns sorted matching record IDs and ignores unrelated files", async () => {
    const directory = await temporaryDirectory();
    await mkdir(join(directory, "nested"));
    await Promise.all([
      writeFile(join(directory, "run_deadbeef.json"), "{}"),
      writeFile(join(directory, "run_1234abcd.json"), "{}"),
      writeFile(join(directory, "other.json"), "{}"),
    ]);
    expect(await listRecordIds(directory, /^(run_[0-9a-f]{8})\.json$/)).toEqual(["run_1234abcd", "run_deadbeef"]);
    expect(await listRecordIds(join(directory, "missing"), /^(run_[0-9a-f]{8})\.json$/)).toEqual([]);
  });
});
