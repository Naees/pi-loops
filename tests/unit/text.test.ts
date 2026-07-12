import { describe, expect, it } from "vitest";
import { TRUNCATION_MARKER, truncateUtf8 } from "../../src/shared/text.js";

describe("UTF-8 text truncation", () => {
  it("preserves text that already fits", () => {
    expect(truncateUtf8("short text", 10)).toBe("short text");
  });

  it("keeps truncated ASCII and multibyte text within the byte limit", () => {
    for (const value of ["x".repeat(100), "界".repeat(100)]) {
      const truncated = truncateUtf8(value, 64);
      expect(Buffer.byteLength(truncated, "utf8")).toBeLessThanOrEqual(64);
      expect(truncated.endsWith(TRUNCATION_MARKER)).toBe(true);
    }
  });

  it("does not retain replacement characters at a multibyte boundary", () => {
    const truncated = truncateUtf8("😀".repeat(20), 27);
    expect(Buffer.byteLength(truncated, "utf8")).toBeLessThanOrEqual(27);
    expect(truncated).not.toContain("�");
    expect(truncated.endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  it("handles limits shorter than the truncation marker", () => {
    const truncated = truncateUtf8("long text", 8);
    expect(Buffer.byteLength(truncated, "utf8")).toBeLessThanOrEqual(8);
    expect(TRUNCATION_MARKER.startsWith(truncated)).toBe(true);
    expect(truncated).not.toContain("�");
  });
});
