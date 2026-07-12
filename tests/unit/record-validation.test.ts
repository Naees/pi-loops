import { describe, expect, it } from "vitest";
import { isBoundedNonEmptyStringArray, isCanonicalIsoDate } from "../../src/storage/record-validation.js";

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
});
