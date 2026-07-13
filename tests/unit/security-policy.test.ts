import { describe, expect, it } from "vitest";
import {
  findPotentialSecrets,
  validateAuditReport,
  validateCycloneDxSbom,
} from "../../scripts/security-policy.mjs";

function audit(overrides: Record<string, number> = {}) {
  return {
    metadata: {
      vulnerabilities: {
        info: 0,
        low: 0,
        moderate: 0,
        high: 0,
        critical: 0,
        total: 0,
        ...overrides,
      },
    },
  };
}

function sbom(license = "MIT") {
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    components: [{
      type: "library",
      name: "dependency",
      version: "1.2.3",
      purl: "pkg:npm/dependency@1.2.3",
      licenses: [{ license: { id: license } }],
    }],
  };
}

describe("Phase 4 security policy", () => {
  it("accepts valid audit counts and rejects high, critical, or malformed reports", () => {
    expect(validateAuditReport(audit({ low: 1, total: 1 }))).toEqual({
      info: 0,
      low: 1,
      moderate: 0,
      high: 0,
      critical: 0,
      total: 1,
    });
    expect(() => validateAuditReport(audit({ high: 1, total: 1 }))).toThrow("1 high and 0 critical");
    expect(() => validateAuditReport(audit({ critical: 1, total: 1 }))).toThrow("0 high and 1 critical");
    expect(() => validateAuditReport({ metadata: { vulnerabilities: { high: "0" } } })).toThrow("invalid info count");
  });

  it("accepts reviewed SPDX licenses and rejects missing, unreviewed, or malformed components", () => {
    expect(validateCycloneDxSbom(sbom())).toEqual([
      { name: "dependency", version: "1.2.3", licenses: ["MIT"] },
    ]);
    expect(() => validateCycloneDxSbom(sbom("GPL-3.0-only"))).toThrow("unreviewed license");
    expect(() => validateCycloneDxSbom({ ...sbom(), components: [{ ...sbom().components[0], licenses: [] }] }))
      .toThrow("no declared SPDX license");
    expect(() => validateCycloneDxSbom({ ...sbom(), components: [{ ...sbom().components[0], purl: "git+https://example.test/repo" }] }))
      .toThrow("invalid production dependency component");
  });

  it("reports high-confidence secrets without logging their values", () => {
    const githubToken = ["ghp", "A".repeat(36)].join("_");
    const npmToken = ["npm", "b".repeat(36)].join("_");
    expect(findPotentialSecrets([
      { path: "safe.txt", text: "ordinary text" },
      { path: "github.txt", text: githubToken },
      { path: "npm.txt", text: npmToken },
      { path: "key.pem", text: ["-----BEGIN", "PRIVATE KEY-----"].join(" ") },
    ])).toEqual([
      { path: "github.txt", kind: "GitHub token" },
      { path: "npm.txt", kind: "npm access token" },
      { path: "key.pem", kind: "PEM private key" },
    ]);
  });
});
