import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

  it("uses ecosystem test commands only when tests are relevant", async () => {
    const path = await project();
    await mkdir(join(path, "src"));
    await writeFile(join(path, "Cargo.toml"), "[package]\nname = \"example\"\nversion = \"0.1.0\"\n");
    expect(await inferProjectVerifierCommands(path, "Fix the failing tests")).toEqual(["cargo test"]);
    expect(await inferProjectVerifierCommands(path, "Update the README")).toEqual([]);
  });
});
