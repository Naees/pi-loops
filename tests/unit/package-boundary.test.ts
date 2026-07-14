import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  findForbiddenPackagePaths,
  findMissingPackagePaths,
  packageFilePaths,
  REQUIRED_PACKAGE_PATHS,
} from "../../scripts/package-boundary.mjs";

describe("package boundary", () => {
  it("uses an explicit public files whitelist", async () => {
    const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
      files?: string[];
      pi?: { extensions?: string[]; skills?: string[] };
      publishConfig?: { access?: string; provenance?: boolean };
      engines?: { node?: string };
      peerDependencies?: Record<string, string>;
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      bundledDependencies?: string[];
      bundleDependencies?: string[];
    };
    expect(manifest.files).toBeDefined();
    expect(manifest.files).not.toContain(".github/");
    expect(manifest.files).not.toContain(".project-design/");
    expect(manifest.files).not.toContain("tests/");
    expect(manifest.files).toContain("skills/");
    expect(manifest.files).toContain("docs/");
    expect(REQUIRED_PACKAGE_PATHS).toEqual([
      "docs/integrations.md",
      "docs/operations.md",
      "skills/pi-loops/SKILL.md",
      "src/extension/index.ts",
    ]);
    expect(manifest.pi).toEqual({ extensions: ["./src/extension/index.ts"], skills: ["./skills"] });
    expect(manifest.engines?.node).toBe(">=22.19.0");
    expect(manifest.publishConfig).toEqual({ access: "public", provenance: true });
    expect(manifest.peerDependencies).toEqual(expect.objectContaining({
      "@earendil-works/pi-ai": "*",
      "@earendil-works/pi-coding-agent": "*",
      typebox: "*",
    }));
    for (const dependencies of [manifest.dependencies, manifest.peerDependencies, manifest.optionalDependencies]) {
      expect(dependencies ?? {}).not.toHaveProperty("pi-subagents");
    }
    expect(manifest.bundledDependencies ?? manifest.bundleDependencies ?? []).not.toContain("pi-subagents");
  });

  it("normalizes package inventories and reports forbidden or missing paths", () => {
    const files = [
      "README.md",
      ...REQUIRED_PACKAGE_PATHS,
      ".github/assets/pi-loops-header.webp",
      ".project-design/brief.md",
      { path: "tests/unit/example.test.ts" },
      { path: ".pi-subagents/output.json" },
      { path: "coverage/index.html" },
      { path: 42 },
    ];
    expect(packageFilePaths(files)).not.toContain(42);
    expect(findForbiddenPackagePaths(files)).toEqual([
      ".github/assets/pi-loops-header.webp",
      ".project-design/brief.md",
      "tests/unit/example.test.ts",
      ".pi-subagents/output.json",
      "coverage/index.html",
    ]);
    expect(findMissingPackagePaths(files)).toEqual([]);
    expect(findMissingPackagePaths(["README.md", REQUIRED_PACKAGE_PATHS[0]])).toEqual(REQUIRED_PACKAGE_PATHS.slice(1));
  });
});
