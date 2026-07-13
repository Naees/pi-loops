# Phase 4 — Production hardening

**Status:** In progress
**Started:** 2026-07-13
**Prerequisite:** Phases 0–3 complete for the validated macOS/Pi 0.80.6 scope
**Platform boundary:** Linux and Windows unattended execution remain fail-closed until Phase 5 native qualification.

## Objective

Turn the implemented feature set into a reviewable release candidate without widening the supported runtime boundary. Phase 4 establishes persisted-state compatibility, calibrated limits, repeatable security and supply-chain gates, public operational documentation, and release-candidate automation. It does not publish the package or claim Linux/Windows support.

## Non-negotiable controls

- Preserve public commands, tool actions, persisted schema version 1, IDs, error behavior, and export namespaces unless a reviewed migration explicitly requires a change.
- Never silently discard, rewrite, or downgrade unknown persisted state.
- Keep unattended execution enabled only for the validated macOS/Pi 0.80.6 combination.
- Keep `.project-design/` out of npm tarballs and retain it in the repository until the final Phase 5 release gate.
- Do not add install, postinstall, preuninstall, or network-listener scripts.
- Do not weaken bounded I/O, path containment, ownership-token leases, Git isolation, child deadlines, permission behavior, or deletion boundaries.
- Do not publish or automatically merge from release automation.

## Delivery slices

### 1. Release and supply-chain baseline

- Add a repeatable security check for production dependency vulnerabilities, production dependency licenses, CycloneDX SBOM validity, and high-confidence committed-secret patterns.
- Add a non-publishing release-candidate command that runs typechecks, tests, coverage, security checks, package inspection, packed installation, and packed unattended fixtures.
- Strengthen the final release gate so it additionally requires the authenticated macOS runtime and process-lifecycle matrix after internal design files are removed.
- Add macOS CI for the minimum Node version and a current supported Node version, plus package/SBOM artifacts. CI success does not qualify Linux or Windows.

### 2. Persisted-state compatibility and upgrades

- Freeze version-1 run, schedule, trigger, configuration, lease, and notice fixtures as the pre-release compatibility baseline.
- Add an explicit migration dispatcher that accepts current records unchanged, applies only reviewed migrations, and fails closed on unknown future versions.
- Run migration only while holding the relevant mutation lease; write migrated state atomically; preserve IDs, project binding, timestamps, budgets, and unresolved-worktree metadata.
- Add packed upgrade tests using an isolated Pi home and project, including interrupted, terminal, scheduled, proactive, and retained-worktree records.
- Add uninstall/reinstall tests that distinguish package files from intentionally retained user runtime data.

### 3. Budget and bound calibration

- Inventory every count, byte, time, retry, debounce, retention, and process-lifecycle bound.
- Record its safety purpose, default, minimum/maximum, test evidence, and user-visible behavior.
- Exercise boundary values and representative real Pi runs; change defaults only when evidence justifies it.
- Confirm the default three active hours, fifteen cycles, and three equivalent failures remain finite and understandable.

### 4. Security hardening and review

- Threat-model parent, child, storage, Git, event bus, evaluator, package, and update boundaries.
- Re-run command-injection, traversal, symlink, malformed framing, hostile event, stale-lock, race, forced-parent-death, and cleanup matrices.
- Review file/directory modes, environment handling, argv, logs, transcript entries, and deletion containment for secret exposure.
- Run static analysis, dependency review, secret scanning, license inventory, SBOM generation, and manual source review.
- Resolve every critical/high finding and record lower-severity dispositions.

### 5. Public documentation and release candidate

- Document exact supported Node/Pi/macOS scope, installation status, runtime lifecycle, data locations, review-branch workflow, permissions, recovery, cleanup, and troubleshooting.
- Document upgrade/uninstall behavior and the strict platform qualification policy.
- Produce a clean packed release candidate and preserve its file inventory, checksum, SBOM, test commands, and compatibility evidence.
- Confirm npm-scope access without publishing.

## Required gates

- `npm run check`
- `npm run test:coverage`
- `npm run security:check`
- `npm run pack:inspect`
- `npm run test:packed`
- packed state-upgrade and uninstall/reinstall tests
- packed scheduled/proactive writer tests
- attended and proactive authenticated macOS E2E
- production RPC lifecycle, including forced parent death 10/10
- repeated contention, takeover, atomic-write, and shutdown subsets
- dependency audit, license inventory, SBOM validation, and secret scan
- `git diff --check` and clean repository state for the release candidate

## Exit criteria

- Persisted version-1 state has an explicit, tested upgrade contract and unknown versions fail closed without mutation.
- Defaults and hard bounds have recorded calibration evidence.
- No unresolved critical/high security or supply-chain finding remains.
- The release-candidate tarball contains only intended files and installs cleanly on the validated macOS baseline.
- Upgrade, reinstall, and uninstall behavior is tested with isolated state.
- Public documentation accurately states current support and limitations.
- Release automation creates reviewable artifacts but cannot publish automatically.
- No known design blocker prevents Phase 5 native Linux and Windows qualification.

## Progress

### 2026-07-13 — release and supply-chain baseline implemented locally

- Added production dependency audit policy, explicit MIT/ISC production-license allowlist, CycloneDX SBOM validation/output, bounded high-confidence tracked-secret scanning, and focused policy tests.
- Added a non-publishing release-candidate command and strengthened the final release gate to require a clean tree plus authenticated macOS runtime and process-lifecycle checks.
- Added macOS Node 22.19/current CI, packed package/SBOM artifacts, CodeQL, dependency review, Dependabot, and a manual non-publishing release-candidate workflow.
- Updated public status, security, changelog, and contributor documentation for Phase 4.
- Local non-runtime and authenticated macOS runtime release-candidate gates passed, including forced parent death 10/10.
- The first hosted run exposed an npm 10 clean-install lockfile incompatibility (`@emnapi/core`/`@emnapi/runtime` were absent). The lockfile was regenerated with npm 10.9.3; the hosted Node 22.19, Node 24, package, SBOM, and CodeQL jobs then passed.
- CodeQL reported one medium test-only code-sanitization finding where a serialized fixture was interpolated into `node -e` source. The fixture now crosses the child boundary as data through a dedicated environment value; focused tests pass and hosted CodeQL revalidation is required to close the alert.

## Initial disposition

The pre-Phase 4 baseline is green at commit `f033d06`: 55 test files / 336 tests, 93.01% line coverage, packed install and package inspection passing, authenticated attended and proactive E2E passing, production RPC lifecycle passing with forced parent death 10/10, and zero audited vulnerabilities. Phase 4 begins with the release/supply-chain baseline; this record does not declare Phase 4 complete.
