import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, parseConfigOverride, resolveConfig, validateConfig } from "../../src/config/config.js";

describe("configuration", () => {
  it("contains the confirmed medium-work defaults", () => {
    expect(DEFAULT_CONFIG.defaults).toEqual({
      maxActiveMs: 3 * 60 * 60 * 1000,
      maxCycles: 15,
      stallThreshold: 3,
    });
    expect(DEFAULT_CONFIG.scheduling.minimumRecurringMs).toBe(5 * 60 * 1000);
    expect(DEFAULT_CONFIG.retention.terminalRunsPerProject).toBe(50);
  });

  it("applies user, project, and invocation precedence", () => {
    const resolved = resolveConfig(
      { defaults: { maxCycles: 20 }, evaluator: { model: "user-model" } },
      { defaults: { maxCycles: 25 }, evaluator: { model: "project-model" } },
      { defaults: { maxCycles: 30 } },
    );

    expect(resolved.defaults.maxCycles).toBe(30);
    expect(resolved.evaluator.model).toBe("project-model");
  });

  it("rejects non-finite or non-positive limits", () => {
    expect(() => resolveConfig({}, {}, { defaults: { maxCycles: 0 } })).toThrow("positive safe integer");
    expect(() =>
      validateConfig({
        ...DEFAULT_CONFIG,
        defaults: { ...DEFAULT_CONFIG.defaults, maxActiveMs: Number.POSITIVE_INFINITY },
      }),
    ).toThrow("positive safe integer");
  });

  it("strictly rejects malformed shapes and unknown keys", () => {
    expect(parseConfigOverride(undefined, "user config")).toEqual({});
    expect(() => parseConfigOverride(null, "user config")).toThrow("must be an object");
    expect(() => parseConfigOverride({ defaults: "large" }, "user config")).toThrow("defaults must be an object");
    expect(() => parseConfigOverride({ unknown: true }, "user config")).toThrow("unknown config key");
    expect(() => parseConfigOverride({ defaults: { maxCycle: 3 } }, "user config")).toThrow("unknown defaults key");
    expect(() => parseConfigOverride({ evaluator: { model: 42 } }, "user config")).toThrow("non-empty string");
    expect(() => parseConfigOverride({ evaluator: { model: "   " } }, "user config")).toThrow("non-empty string");
    expect(() => parseConfigOverride({ scheduling: { unknown: 1 } }, "user config")).toThrow("unknown scheduling key");
    expect(() => parseConfigOverride({ retention: { unknown: 1 } }, "user config")).toThrow("unknown retention key");
    expect(() => parseConfigOverride({ evaluator: { unknown: 1 } }, "user config")).toThrow("unknown evaluator key");
    for (const input of [
      { defaults: { maxActiveMs: 1.5 } },
      { defaults: { stallThreshold: -1 } },
      { scheduling: { minimumRecurringMs: 0 } },
      { retention: { terminalRunsPerProject: Number.POSITIVE_INFINITY } },
    ]) {
      expect(() => parseConfigOverride(input, "user config")).toThrow("positive safe integer");
    }
    expect(() => parseConfigOverride({ schemaVersion: 2 }, "user config")).toThrow("unsupported schemaVersion");
  });
});
