# Phase 4 — Production hardening

**Status:** Complete for the validated macOS/Pi 0.80.6 scope; Phase 5 may begin
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

### 2026-07-13 — release and supply-chain baseline implemented and validated

- Added production dependency audit policy, explicit MIT/ISC production-license allowlist, CycloneDX SBOM validation/output, bounded high-confidence tracked-secret scanning, and focused policy tests.
- Added a non-publishing release-candidate command and strengthened the final release gate to require a clean tree plus authenticated macOS runtime and process-lifecycle checks.
- Added macOS Node 22.19/current CI, packed package/SBOM artifacts, CodeQL, dependency review, Dependabot, and a manual non-publishing release-candidate workflow.
- Updated public status, security, changelog, and contributor documentation for Phase 4.
- Local non-runtime and authenticated macOS runtime release-candidate gates passed, including forced parent death 10/10.
- The first hosted run exposed an npm 10 clean-install lockfile incompatibility (`@emnapi/core`/`@emnapi/runtime` were absent). The lockfile was regenerated with npm 10.9.3; the hosted Node 22.19, Node 24, package, SBOM, and CodeQL jobs then passed.
- CodeQL reported one medium test-only code-sanitization finding where a serialized fixture was interpolated into `node -e` source. The fixture now crosses the child boundary as data through a dedicated environment value; hosted CodeQL revalidation passed with zero open alerts.
- Hosted CI is green on Node 22.19 and Node 24, including clean install, the complete suite, security policy, packed install, packed unattended fixtures, SBOM generation, tarball creation, and artifact upload. Delivery slice 1 is closed.

### 2026-07-13 — persisted-state compatibility implemented locally

- Added an explicit sequential migration dispatcher for run, schedule, and trigger records. It accepts schema version 1 unchanged, requires every reviewed migration to advance exactly one version, validates each returned version, clones source input before migration, and fails closed on missing paths or unknown newer versions.
- The current production migration registry is intentionally empty because no schema older than version 1 has been publicly released. No fictional version-zero data is accepted.
- Store loads validate prepared records and may persist migrated output only while holding the relevant mutation lease, using the existing bounded atomic-write path. Focused tests prove unlocked loads cannot rewrite migration output.
- Frozen version-one fixtures now cover runs, schedules, triggers, resolved configuration, and notices. Lease records remain ephemeral ownership metadata: the authoritative live lock must never be migrated or taken over by package upgrade code.
- Added a packed compatibility gate that installs the tarball, reads all frozen state without rewriting it, rejects newer versions without mutation, installs over the existing package, uninstalls, reinstalls, and proves package operations preserve user runtime state while uninstall removes package files.
- Local typechecks, 59 test files / 348 tests, 93.08% line coverage, focused store/migration tests, packed upgrade/uninstall/reinstall, and the complete authenticated macOS runtime release-candidate gate pass.
- Hosted Node 22.19 and Node 24 CI, packed state compatibility, package artifacts, and CodeQL passed at `629951c` with zero open code-scanning alerts. Delivery slice 2 is closed.

### 2026-07-13 — budget and bound calibration completed

- Inventoried user budgets, workflow counts, field and record bytes, evaluator and RPC aggregates, trigger admission, lease timing, subprocess timeouts, shutdown escalation, and long-timer behavior in `.project-design/release/phase-4-bounds-calibration.md`.
- Compared every boundary with focused tests, packed release-candidate evidence, contention stress, and authenticated Pi lifecycle results.
- Retained the three-active-hour, fifteen-cycle, and three-equivalent-failure defaults. No safety ceiling was widened and no undocumented clamp was introduced for existing version-one budgets.
- Documented the evaluator aggregate ceiling, protected-record retention tradeoff, absence of a provider monetary cap, and exact public operational limits in `README.md`.
- No critical/high bound defect remains in the validated macOS scope. Delivery slice 3 is closed; Linux and Windows calibration remains Phase 5 work.

### 2026-07-13 — comprehensive security review first pass

- Recorded assets, threat sources, parent/child/storage/Git/event/evaluator/update boundaries, controls, findings, and residual risks in `.project-design/release/phase-4-security-review.md`.
- Found and fixed four remaining unbounded or growth-after-stat JSON file reads: notice state, lease metadata, project package inference, and current-Pi package identity now use the single-handle bounded reader.
- Pinned every external GitHub Action to the exact previously tested commit SHA and added a policy test/security gate that rejects mutable workflow references.
- Added malformed/oversized notice, oversized lease metadata, and oversized current-Pi manifest coverage; focused tests pass.
- The complete authenticated local release-candidate gate passed with 59 test files / 352 tests, 93.32% line coverage, 84.12% branch coverage, and forced parent death 10/10.
- Hosted Node 22.19/24 CI, packed package/state jobs, current-major immutable Actions, and CodeQL passed at `db0cdc5` with zero open alerts. No critical/high finding remains; delivery slice 4 is closed.

### 2026-07-13 — public operations and release-candidate documentation

- Added packaged public operations/recovery/data/upgrade/troubleshooting documentation and a strict extension event integration contract. README links both references.
- Added explicit public-access and npm-provenance publish metadata; package and packed-install gates require the documents and metadata.
- CI/release-candidate artifacts now include npm's JSON file inventory, CycloneDX SBOM, tarball, and SHA-256 checksum.
- Added `release:dry-run`, which validates the exact npm publication report, forbidden/required files, public identity, provenance policy, and absence of bundled dependencies without publishing.
- The publication dry-run passed. Live `npm whoami` now returns `E401`, so publisher authentication must be restored explicitly before final publication; Pi Loops does not inspect or modify npm credentials.
- Local authenticated release-candidate, Node 22.19/24 CI, CodeQL, package/state jobs, and publication dry-run passed. Download verification exposed an artifact-relative checksum-path defect; it was fixed and the regenerated hosted artifact verified successfully after download.
- Final manual release-candidate run `29236771626` at closure commit `9a2694f` produced a 67-file tarball, CycloneDX SBOM, npm JSON inventory, and valid SHA-256 checksum. The downloaded artifact verified successfully. Delivery slice 5 and Phase 4 are closed for the validated macOS/Pi 0.80.6 scope.

## Initial disposition

The pre-Phase 4 baseline is green at commit `f033d06`: 55 test files / 336 tests, 93.01% line coverage, packed install and package inspection passing, authenticated attended and proactive E2E passing, production RPC lifecycle passing with forced parent death 10/10, and zero audited vulnerabilities. Phase 4 begins with the release/supply-chain baseline; this record does not declare Phase 4 complete.
