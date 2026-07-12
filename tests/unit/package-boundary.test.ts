import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("package boundary", () => {
  it("uses an explicit public files whitelist", async () => {
    const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
      files?: string[];
      pi?: { skills?: string[] };
    };
    expect(manifest.files).toBeDefined();
    expect(manifest.files).not.toContain(".project-design/");
    expect(manifest.files).not.toContain("tests/");
    expect(manifest.files).toContain("skills/");
    expect(manifest.pi?.skills).toEqual(["./skills"]);
  });
});
