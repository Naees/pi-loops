import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePiAgentDirectory, resolvePiLoopsDataRoot } from "../../src/storage/paths.js";

describe("storage paths", () => {
  it("honors Pi's documented config-directory override", () => {
    expect(resolvePiAgentDirectory({ environment: { PI_CODING_AGENT_DIR: "/tmp/custom-pi" } })).toBe(resolve("/tmp/custom-pi"));
    expect(resolvePiLoopsDataRoot({ environment: { PI_CODING_AGENT_DIR: "/tmp/custom-pi" } })).toBe(
      join(resolve("/tmp/custom-pi"), "pi-loops"),
    );
  });

  it("defaults beneath the user's Pi agent directory", () => {
    expect(resolvePiAgentDirectory({ environment: {}, homeDirectory: "/home/example" })).toBe(
      join("/home/example", ".pi", "agent"),
    );
  });
});
