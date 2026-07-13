import { describe, expect, it } from "vitest";
import {
  hasValidStoredCompletionDefinition,
  isBoundedNonEmptyStringArray,
  isCanonicalIsoDate,
} from "../../src/storage/record-validation.js";

describe("shared validation", () => {
  it("recognizes canonical ISO timestamps only", () => {
    expect(isCanonicalIsoDate("2026-07-12T12:00:00.000Z")).toBe(true);
    expect(isCanonicalIsoDate("2026-07-12T12:00:00Z")).toBe(false);
    expect(isCanonicalIsoDate("not-a-date")).toBe(false);
  });

  it("bounds non-empty string arrays by item count and UTF-8 bytes", () => {
    expect(isBoundedNonEmptyStringArray(["one", "two"], 2, 3)).toBe(true);
    expect(isBoundedNonEmptyStringArray(["one", "two", "three"], 2, 8)).toBe(false);
    expect(isBoundedNonEmptyStringArray([""], 1, 1)).toBe(false);
    expect(isBoundedNonEmptyStringArray(["é"], 1, 1)).toBe(false);
  });

  it("validates the completion-definition fields shared by schedules and triggers", () => {
    const definition = {
      goal: "Keep working",
      constraints: ["Preserve behavior"],
      verifierCommands: ["npm test"],
      budget: { maxActiveMs: 60_000, maxCycles: 2, stallThreshold: 2 },
    };
    expect(hasValidStoredCompletionDefinition(definition)).toBe(true);
    expect(hasValidStoredCompletionDefinition({ ...definition, goal: "x".repeat(16 * 1024) })).toBe(true);
    expect(hasValidStoredCompletionDefinition({ ...definition, goal: "x".repeat(16 * 1024 + 1) })).toBe(false);
    expect(hasValidStoredCompletionDefinition({ ...definition, goal: " " })).toBe(false);
    expect(hasValidStoredCompletionDefinition({ ...definition, constraints: [""] })).toBe(false);
    expect(hasValidStoredCompletionDefinition({ ...definition, constraints: Array.from({ length: 51 }, () => "constraint") })).toBe(false);
    expect(hasValidStoredCompletionDefinition({ ...definition, verifierCommands: Array.from({ length: 21 }, () => "npm test") })).toBe(false);
    expect(hasValidStoredCompletionDefinition({ ...definition, budget: { ...definition.budget, maxCycles: 0 } })).toBe(false);
  });
});
