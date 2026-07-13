import { isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";
import { localVitestInvocation, npmInvocation, piInvocation } from "../../scripts/platform-command.mjs";

describe("cross-platform script commands", () => {
  it("launches npm through its absolute JavaScript entry point when available", () => {
    const npmCli = join(process.cwd(), "tools", "npm-cli.js");
    expect(npmInvocation(["pack", "--json"], { npm_execpath: npmCli }, "win32")).toEqual({
      executable: process.execPath,
      args: [npmCli, "pack", "--json"],
    });
    expect(() => npmInvocation([], {}, "win32")).toThrow("absolute npm_execpath");
  });

  it("launches the local Vitest JavaScript entry point through Node", () => {
    const invocation = localVitestInvocation(["run"]);
    expect(invocation.executable).toBe(process.execPath);
    expect(isAbsolute(invocation.args[0] ?? "")).toBe(true);
    expect(invocation.args.slice(1)).toEqual(["run"]);
  });

  it("prefers an explicitly absolute Pi CLI without shell shims", () => {
    const cli = join(process.cwd(), "node_modules", "pi", "dist", "cli.js");
    expect(piInvocation({ PI_LOOPS_TEST_PI_CLI: cli })).toEqual({ executable: process.execPath, argsPrefix: [cli] });
    expect(() => piInvocation({ PI_LOOPS_TEST_PI_CLI: "relative-cli.js" })).toThrow("must be absolute");
  });
});
