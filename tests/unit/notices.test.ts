import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NoticeStore } from "../../src/storage/notices.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("persistent notices", () => {
  it("rejects malformed, unknown, and oversized notice state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-loops-notices-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "notices.json");
    const notices = new NoticeStore(directory);

    await writeFile(path, "not-json");
    await expect(notices.shouldShowSubagentsRecommendation()).rejects.toBeInstanceOf(SyntaxError);
    for (const invalid of [
      null,
      [],
      {},
      { schemaVersion: 2, subagentsRecommended: true },
      { schemaVersion: 1, subagentsRecommended: "yes" },
      { schemaVersion: 1, subagentsRecommended: true, hostile: true },
    ]) {
      await writeFile(path, JSON.stringify(invalid));
      await expect(notices.shouldShowSubagentsRecommendation()).rejects.toThrow("notice record is invalid");
    }
    await writeFile(path, Buffer.alloc(16 * 1024 + 1));
    await expect(notices.shouldShowSubagentsRecommendation()).rejects.toThrow("notice record is oversized");
  });

  it("shows the subagent recommendation only until it is recorded", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-loops-notices-"));
    temporaryDirectories.push(directory);
    const first = new NoticeStore(directory);
    expect(await first.shouldShowSubagentsRecommendation()).toBe(true);
    await first.markSubagentsRecommendationShown();
    expect(await new NoticeStore(directory).shouldShowSubagentsRecommendation()).toBe(false);
  });
});
