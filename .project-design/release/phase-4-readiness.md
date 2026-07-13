# Phase 4 production-hardening readiness

**Date:** 2026-07-13
**Status:** Complete for the validated macOS/Pi 0.80.6 scope
**Disposition:** Phase 5 native Linux and Windows qualification may begin. No public npm release is authorized.

## Delivered

### Persisted-state compatibility

- Added explicit sequential migration dispatch for run, schedule, and trigger records.
- Version-one records pass unchanged; unknown newer versions fail closed without mutation.
- Migration output is strictly validated and atomically persisted only while the relevant writer lease is held.
- Frozen version-one run, terminal run, retained-worktree run, schedule, trigger, configuration, and notice fixtures are checked by source and packed-package tests.
- Packed install, upgrade, uninstall, and reinstall preserves all fixtures byte-for-byte, including interrupted state, IDs, bindings, budgets, timestamps, and retained worktree metadata.

### Bounds and lifecycle calibration

- Inventoried count, byte, duration, debounce, retry, retention, lease, process, and platform bounds.
- Reviewed safety ceilings and boundary tests in `.project-design/release/phase-4-bounds-calibration.md`.
- Retained the 3 active-hour, 15-cycle, 3-equivalent-failure, and 50-terminal-record product defaults.
- Kept unattended runtime fail-closed outside macOS/Pi 0.80.6 pending Phase 5.

### Security and supply chain

- Completed the parent/child, storage, Git, event, evaluator, package, and update threat-model review in `.project-design/release/phase-4-security-review.md`.
- Closed bounded-read growth races for notices, leases, project manifests, and Pi manifests.
- Enforced high/critical production advisory rejection, explicit MIT/ISC production-license policy, CycloneDX SBOM validation, and bounded tracked-secret scanning.
- Updated external GitHub Actions to reviewed current majors pinned by immutable commit SHA; policy tests reject mutable references.
- Hosted CodeQL reports zero open alerts. No critical/high finding remains.
- Reviewed and closed generated development-only Dependabot updates individually to preserve the qualified toolchain; no production update is pending.

### Public operations and release automation

- Added packaged operations, data, recovery, review-branch, upgrade, uninstall, and troubleshooting documentation.
- Added the packaged strict extension event integration contract.
- Added public-access and npm-provenance publishing metadata.
- Added a non-publishing npm publication dry-run validating identity, inventory, required/forbidden paths, public policy, and absence of bundled dependencies.
- CI and manual release-candidate workflows produce the npm tarball, npm JSON inventory, CycloneDX SBOM, and artifact-relative SHA-256 checksum without publishing.
- Downloaded artifact verification caught and closed the checksum-path defect before release.

## Final evidence

### Local authenticated runtime release candidate

`npm run release:candidate:runtime` passed on macOS with Pi 0.80.6:

- 59 test files / 352 tests.
- 93.22% line and 83.98% branch coverage.
- Zero audited production vulnerabilities.
- Four production dependencies with reviewed MIT/ISC licenses.
- Packed installation and exact version-one state compatibility.
- Packed scheduled- and proactive-writer, authenticated attended, authenticated proactive-runtime, and production RPC lifecycle E2Es.
- Forced parent-death cleanup 10/10.
- Publication dry-run: 67 files, public access with provenance, no publication.

### Hosted validation

Commit `a154c4e`:

- CI run `29235967532`: Node 22.19.0 and Node 24.x clean installs/tests/security checks passed; packed install/state/scheduled jobs passed; SBOM, inventory, checksum, and package artifact uploaded.
- Security run `29235967504`: pinned CodeQL v4 passed; zero open code-scanning alerts. Dependency review was correctly skipped for a push event.
- Manual release-candidate run `29236169822`: complete non-publishing baseline and artifact build passed.

Downloaded artifact evidence:

- `naees-pi-loops-0.1.0.tgz`
- 67 files; 80,139 packed bytes.
- SHA-256 `996f803f1b97b6f02757a19f0b4f6f6b11140ef7eada62ae31bdf550851376f8`.
- CycloneDX 1.5 SBOM with four production dependency components.
- `shasum -a 256 -c SHA256SUMS` passed after artifact download.

## Remaining gates and non-blockers

- `.project-design/` intentionally remains in the repository and must be removed before publication. It is excluded from the npm tarball, and `release:check` continues to block while it exists.
- Linux and Windows unattended execution remains fail-closed pending native Phase 5 qualification.
- Live npm authentication currently returns `E401`; the publisher must explicitly restore authentication and rerun the final access gate before publication. Pi Loops will not inspect or modify credentials.
- No install, postinstall, preuninstall, daemon, hosted listener, credential-storage, environment-snapshot, or automatic-merge behavior was introduced.

These are final publication/Phase 5 gates, not blockers to starting Phase 5 qualification.
