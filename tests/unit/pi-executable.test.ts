import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCurrentPiLaunchCommand } from "../../src/worker/pi-executable.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-loops-executable-"));
  temporaryDirectories.push(root);
  return root;
}

async function createNodeCli(root: string, version: string, source = "// fixture\n"): Promise<string> {
  const packageRoot = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
  const cli = join(packageRoot, "dist", "cli.js");
  await mkdir(join(packageRoot, "dist"), { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version }));
  await writeFile(cli, source);
  return cli;
}

describe("current Pi executable resolution", () => {
  it("uses the current Node CLI instead of searching PATH", async () => {
    const root = await temporaryRoot();
    const cli = await createNodeCli(root, "0.82.1");
    const probeVersion = vi.fn(async () => "0.82.1");

    const resolved = await resolveCurrentPiLaunchCommand({
      execPath: process.execPath,
      argv: [process.execPath, cli],
      probeVersion,
    });

    const canonicalCli = await realpath(cli);
    expect(resolved).toEqual({
      executable: await realpath(process.execPath),
      argsPrefix: [canonicalCli],
      version: "0.82.1",
      source: "current-node-cli",
    });
    expect(probeVersion).toHaveBeenCalledWith(await realpath(process.execPath), [canonicalCli]);
  });

  it("supports a validated current standalone Pi binary", async () => {
    const root = await temporaryRoot();
    const executable = join(root, process.platform === "win32" ? "pi.exe" : "pi");
    await writeFile(executable, "fixture\n");
    await chmod(executable, 0o700);

    await expect(resolveCurrentPiLaunchCommand({
      execPath: executable,
      argv: [executable],
      probeVersion: async () => "1.2.3-beta.1",
    })).resolves.toEqual({
      executable: await realpath(executable),
      argsPrefix: [],
      version: "1.2.3-beta.1",
      source: "current-binary",
    });
  });

  it("fails closed for an unrecognized host process", async () => {
    await expect(resolveCurrentPiLaunchCommand({
      execPath: process.execPath,
      argv: [process.execPath, "/tmp/unrelated-script.js"],
      probeVersion: async () => "0.82.1",
    })).rejects.toThrow("Could not identify the current Pi installation");
  });

  it("rejects unexpected version output", async () => {
    const root = await temporaryRoot();
    const cli = await createNodeCli(root, "0.82.1");

    await expect(resolveCurrentPiLaunchCommand({
      execPath: process.execPath,
      argv: [process.execPath, cli],
      probeVersion: async () => "not-pi",
    })).rejects.toThrow("Unexpected version output");
  });

  it("rejects a mismatched package identity or version", async () => {
    const root = await temporaryRoot();
    const cli = await createNodeCli(root, "0.80.5");

    await expect(resolveCurrentPiLaunchCommand({
      execPath: process.execPath,
      argv: [process.execPath, cli],
      probeVersion: async () => "0.82.1",
    })).rejects.toThrow("does not match executable version");
  });

  it("bounds the current Pi package manifest read", async () => {
    const root = await temporaryRoot();
    const cli = await createNodeCli(root, "0.82.1");
    await writeFile(join(cli, "..", "..", "package.json"), Buffer.alloc(256 * 1024 + 1));

    await expect(resolveCurrentPiLaunchCommand({
      execPath: process.execPath,
      argv: [process.execPath, cli],
      probeVersion: async () => "0.82.1",
    })).rejects.toThrow("Pi package manifest exceeds 262144 bytes");
  });

  it("runs the real version probe without shell interpolation", async () => {
    const root = await temporaryRoot();
    const unsafeRoot = join(root, "path with spaces; touch SHOULD_NOT_EXIST");
    const cli = await createNodeCli(
      unsafeRoot,
      "2.3.4",
      'if (process.argv.includes("--version")) process.stdout.write("2.3.4");\n',
    );

    const resolved = await resolveCurrentPiLaunchCommand({ execPath: process.execPath, argv: [process.execPath, cli] });

    expect(resolved.version).toBe("2.3.4");
    await expect(realpath(join(root, "SHOULD_NOT_EXIST"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("bounds real version-probe output and reports nonzero exits", async () => {
    const root = await temporaryRoot();
    const oversized = await createNodeCli(join(root, "oversized"), "1.0.0", 'process.stdout.write("x".repeat(20 * 1024));\n');
    await expect(resolveCurrentPiLaunchCommand({
      execPath: process.execPath,
      argv: [process.execPath, oversized],
    })).rejects.toThrow("version probe exceeds 16384 bytes");

    const failing = await createNodeCli(join(root, "failing"), "1.0.0", 'console.error("controlled failure"); process.exit(2);\n');
    await expect(resolveCurrentPiLaunchCommand({
      execPath: process.execPath,
      argv: [process.execPath, failing],
    })).rejects.toThrow("controlled failure");
  });

  it("enforces valid bounded version-probe timeouts", async () => {
    for (const versionProbeTimeoutMs of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
      await expect(resolveCurrentPiLaunchCommand({
        execPath: process.execPath,
        argv: [process.execPath, "/tmp/pi-coding-agent/dist/cli.js"],
        versionProbeTimeoutMs,
      })).rejects.toThrow("positive safe integer");
    }

    const root = await temporaryRoot();
    const cli = await createNodeCli(root, "1.0.0", "setInterval(() => {}, 1000);\n");

    await expect(resolveCurrentPiLaunchCommand({
      execPath: process.execPath,
      argv: [process.execPath, cli],
      versionProbeTimeoutMs: 25,
    })).rejects.toThrow("timed out after 25ms");
  });
});
