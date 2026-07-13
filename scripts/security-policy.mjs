export const APPROVED_PRODUCTION_LICENSES = Object.freeze(["ISC", "MIT"]);

const SECRET_PATTERNS = Object.freeze([
  { name: "PEM private key", pattern: /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/ },
  { name: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "GitHub token", pattern: /\b(?:gho|ghp|ghr|ghs|ghu)_[A-Za-z0-9]{36,}\b/ },
  { name: "GitHub fine-grained token", pattern: /\bgithub_pat_[A-Za-z0-9_]{50,}\b/ },
  { name: "npm access token", pattern: /\bnpm_[A-Za-z0-9]{36,}\b/ },
]);

function object(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

export function validateAuditReport(value) {
  const report = object(value);
  const metadata = object(report?.metadata);
  const vulnerabilities = object(metadata?.vulnerabilities);
  if (!vulnerabilities) throw new Error("npm audit returned an invalid vulnerability report");
  const counts = {};
  for (const severity of ["info", "low", "moderate", "high", "critical", "total"]) {
    const count = vulnerabilities[severity];
    if (!Number.isSafeInteger(count) || count < 0) throw new Error(`npm audit returned an invalid ${severity} count`);
    counts[severity] = count;
  }
  if (counts.high > 0 || counts.critical > 0) {
    throw new Error(`Production dependency audit found ${counts.high} high and ${counts.critical} critical vulnerabilities`);
  }
  return counts;
}

function componentLicenses(component) {
  if (!Array.isArray(component.licenses)) return [];
  return component.licenses.flatMap((entry) => {
    const license = object(entry)?.license;
    const identifier = object(license)?.id;
    return typeof identifier === "string" ? [identifier] : [];
  });
}

export function validateCycloneDxSbom(value, approvedLicenses = APPROVED_PRODUCTION_LICENSES) {
  const sbom = object(value);
  if (sbom?.bomFormat !== "CycloneDX" || typeof sbom.specVersion !== "string" || !Array.isArray(sbom.components)) {
    throw new Error("npm sbom returned an invalid CycloneDX document");
  }
  const approved = new Set(approvedLicenses);
  const inventory = sbom.components.map((value) => {
    const component = object(value);
    if (!component || component.type !== "library" || typeof component.name !== "string" ||
      typeof component.version !== "string" || typeof component.purl !== "string" || !component.purl.startsWith("pkg:npm/")) {
      throw new Error("CycloneDX contains an invalid production dependency component");
    }
    const licenses = componentLicenses(component);
    if (licenses.length === 0) throw new Error(`${component.name}@${component.version} has no declared SPDX license`);
    const unapproved = licenses.filter((license) => !approved.has(license));
    if (unapproved.length > 0) {
      throw new Error(`${component.name}@${component.version} has unreviewed license(s): ${unapproved.join(", ")}`);
    }
    return { name: component.name, version: component.version, licenses: [...licenses].sort() };
  });
  return inventory.sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`));
}

export function findPotentialSecrets(entries) {
  const findings = [];
  for (const entry of entries) {
    if (!entry || typeof entry.path !== "string" || typeof entry.text !== "string") continue;
    for (const { name, pattern } of SECRET_PATTERNS) {
      if (pattern.test(entry.text)) findings.push({ path: entry.path, kind: name });
    }
  }
  return findings;
}

export function findUnpinnedGitHubActions(entries) {
  const findings = [];
  for (const entry of entries) {
    if (!entry || typeof entry.path !== "string" || typeof entry.text !== "string" ||
      !entry.path.startsWith(".github/workflows/")) continue;
    for (const [index, line] of entry.text.split("\n").entries()) {
      const match = line.match(/^\s*-\s+uses:\s+["']?([^\s"'#]+)["']?/);
      const uses = match?.[1];
      if (!uses || uses.startsWith("./") || uses.startsWith("docker://")) continue;
      if (!/@[0-9a-f]{40}$/.test(uses)) findings.push({ path: entry.path, line: index + 1, uses });
    }
  }
  return findings;
}
