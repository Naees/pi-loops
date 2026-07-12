import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NoticeStore } from "../../src/storage/notices.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("persistent notices", () => {
  it("shows the subagent recommendation only until it is recorded", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-loops-notices-"));
    temporaryDirectories.push(directory);
    const first = new NoticeStore(directory);
    expect(await first.shouldShowSubagentsRecommendation()).toBe(true);
    await first.markSubagentsRecommendationShown();
    expect(await new NoticeStore(directory).shouldShowSubagentsRecommendation()).toBe(false);
  });
});
