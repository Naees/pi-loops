import { describe, expect, it } from "vitest";
import {
  findPotentialSecrets,
  findUnpinnedGitHubActions,
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
    expect(() => validateAuditReport(audit({ moderate: -1 }))).toThrow("invalid moderate count");
    expect(() => validateAuditReport(audit({ total: 1.5 }))).toThrow("invalid total count");
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
    expect(() => validateCycloneDxSbom({ ...sbom(), components: [{ ...sbom().components[0], licenses: [{ license: { name: "MIT" } }] }] }))
      .toThrow("no declared SPDX license");

    const second = { ...sbom("ISC").components[0], name: "alpha", licenses: [{ license: { id: "MIT" } }, { license: { id: "ISC" } }] };
    expect(validateCycloneDxSbom({ ...sbom(), components: [sbom().components[0], second] })).toEqual([
      { name: "alpha", version: "1.2.3", licenses: ["ISC", "MIT"] },
      { name: "dependency", version: "1.2.3", licenses: ["MIT"] },
    ]);
  });

  it("requires external GitHub Actions to use immutable commit SHAs", () => {
    expect(findUnpinnedGitHubActions([{
      path: ".github/workflows/ci.yml",
      text: [
        "steps:",
        "  - uses: actions/checkout@v4",
        "  - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4",
        "  - uses: ./local-action",
        "  - uses: docker://alpine:3.20",
      ].join("\n"),
    }, {
      path: "README.md",
      text: "- uses: example/untrusted@main",
    }])).toEqual([{
      path: ".github/workflows/ci.yml",
      line: 2,
      uses: "actions/checkout@v4",
    }]);
  });

  it("reports high-confidence secrets without logging their values", () => {
    const githubToken = ["ghp", "A".repeat(36)].join("_");
    const fineGrainedToken = ["github", "pat", "A".repeat(25), "B".repeat(25)].join("_");
    const npmToken = ["npm", "b".repeat(36)].join("_");
    const awsKey = `AKIA${"C".repeat(16)}`;
    expect(findPotentialSecrets([
      { path: "safe.txt", text: "ordinary text" },
      { path: "github.txt", text: githubToken },
      { path: "github-fine.txt", text: fineGrainedToken },
      { path: "npm.txt", text: npmToken },
      { path: "aws.txt", text: awsKey },
      { path: "key.pem", text: ["-----BEGIN", "PRIVATE KEY-----"].join(" ") },
    ])).toEqual([
      { path: "github.txt", kind: "GitHub token" },
      { path: "github-fine.txt", kind: "GitHub fine-grained token" },
      { path: "npm.txt", kind: "npm access token" },
      { path: "aws.txt", kind: "AWS access key" },
      { path: "key.pem", kind: "PEM private key" },
    ]);
  });
});
