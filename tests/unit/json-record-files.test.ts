import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listRecordIds,
  readBoundedJsonFile,
  readStoredJsonRecord,
  writeStoredJsonRecord,
} from "../../src/storage/json-record-files.js";

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

  it("reads and writes bounded current-version stored records", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "record.json");
    const record = { schemaVersion: 1, value: "stored" };
    await writeStoredJsonRecord(path, record, 100, "too large");
    await expect(readStoredJsonRecord(path, "run", 100, "too large", (value) => value))
      .resolves.toEqual({ record, migrated: false });
    const formattingHeavy = { schemaVersion: 1, values: Array.from({ length: 10 }, () => 1) };
    expect(Buffer.byteLength(JSON.stringify(formattingHeavy), "utf8")).toBeLessThan(100);
    await expect(writeStoredJsonRecord(path, formattingHeavy, 100, "too large")).rejects.toThrow("too large");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(record);
  });

  it("rejects future stored versions before parsing or rewriting them", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "record.json");
    const future = `${JSON.stringify({ schemaVersion: 2, value: "future" }, null, 2)}\n`;
    await writeFile(path, future);
    const parse = vi.fn((value: unknown) => value);

    await expect(readStoredJsonRecord(path, "run", 1_000, "too large", parse))
      .rejects.toThrow("schemaVersion 2 is newer than supported version 1");
    expect(parse).not.toHaveBeenCalled();
    expect(await readFile(path, "utf8")).toBe(future);
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
