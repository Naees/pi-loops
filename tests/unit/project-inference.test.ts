import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inferProjectVerifierCommands } from "../../src/contracts/project-inference.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function project(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "pi-loops-inference-"));
  temporaryDirectories.push(path);
  return path;
}

describe("project verifier inference", () => {
  it("uses existing package scripts conservatively", async () => {
    const path = await project();
    await writeFile(join(path, "package.json"), JSON.stringify({ scripts: { test: "vitest run", lint: "eslint .", build: "tsc" } }));

    expect(await inferProjectVerifierCommands(path, "Fix the build and lint errors")).toEqual([
      "npm test",
      "npm run lint",
      "npm run build",
    ]);
  });

  it("ignores npm's placeholder test script", async () => {
    const path = await project();
    await writeFile(join(path, "package.json"), JSON.stringify({ scripts: { test: "echo \"Error: no test specified\" && exit 1" } }));
    expect(await inferProjectVerifierCommands(path, "Implement the feature")).toEqual([]);
  });

  it.each([
    ["Cargo.toml", "cargo test"],
    ["go.mod", "go test ./..."],
    ["pyproject.toml", "pytest"],
  ])("uses the %s ecosystem test command only when tests are relevant", async (manifest, command) => {
    const path = await project();
    await writeFile(join(path, manifest), "fixture\n");
    expect(await inferProjectVerifierCommands(path, "Fix the failing tests")).toEqual([command]);
    expect(await inferProjectVerifierCommands(path, "Update the README")).toEqual([]);
  });

  it("ignores malformed, non-object, and oversized package manifests", async () => {
    for (const contents of ["not json", "[]", JSON.stringify({ scripts: [] }), "x".repeat(256 * 1024 + 1)]) {
      const path = await project();
      await writeFile(join(path, "package.json"), contents);
      expect(await inferProjectVerifierCommands(path, "Build and test the project")).toEqual([]);
    }
  });
});
