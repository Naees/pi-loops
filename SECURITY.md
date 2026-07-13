# Security Policy

Pi extensions execute with the user's system permissions. Review the source before installing development or prerelease builds.

## Supported versions

No public version is currently supported. This policy will be updated before the first release.

## Reporting a vulnerability

Please report suspected vulnerabilities privately through GitHub's security-advisory feature for `Naees/pi-loops`. Do not open a public issue for an unpatched vulnerability.

Include reproduction steps, affected platforms, expected impact, and any suggested mitigation. Reports will be acknowledged as soon as practical.

## Automated checks

Phase 4 security automation validates production dependency advisories, reviewed SPDX licenses, a CycloneDX production-dependency SBOM, high-confidence tracked-secret patterns, package contents, and static analysis. These automated checks supplement rather than replace manual review of process, filesystem, Git, event, evaluator, and deletion boundaries.

## Release requirements

A public release is blocked by unresolved critical or high-severity findings, an unproven child-process cleanup guarantee, unintended files in the npm tarball, an unclean release tree, or failure of the authenticated macOS runtime gates. Linux and Windows support additionally requires the native Phase 5 qualification matrix for each platform.
