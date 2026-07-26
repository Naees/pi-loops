# Changelog

Pi Loops follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- Upgrade the coupled Pi development runtime packages and requalify unattended scheduled and proactive writers for Pi 0.82.1 across macOS, Ubuntu 24.04, and Windows Server 2025.

### Fixed

- Allow completion evaluation through providers whose authentication resolves through request headers or ambient credentials instead of an API key.

## [0.1.1] - 2026-07-15

### Fixed

- Persist schedule-definition pause/resume transitions and forward explicit guidance to resumed unattended work while rejecting unsupported budget overrides.
- Retry trigger settlement without unhandled rejections or shutdown hangs, and serialize watcher failures against concurrent trigger launches.
- Re-arm filesystem watchers after safe same-path replacements and persist bounded watcher diagnostics for `/loops status`.
- Keep release-candidate artifact validation usable after the manifest version has already been published.

## [0.1.0] - 2026-07-12

Initial release.

### Added

- Bounded attended goals with deterministic verifier precedence, fresh completion evaluation, finite budgets, stall detection, interruption recovery, and resume.
- Confirmed one-off and recurring schedules with missed-run discard and single-occurrence overlap coalescing.
- Confirmed project-contained filesystem and event triggers with debounce, deduplication, bounded ingress, and restart recovery.
- Isolated worktrees and retained `pi-loops/<run-id>` review branches for unattended writers; branches are never merged automatically.
- Strict versioned state, atomic writes, cross-process leases, bounded retention, and non-destructive upgrade and uninstall behavior.
- Parent-bound RPC worker lifecycle, descendant cleanup, and Windows kill-on-close Job Object containment.
- Native unattended qualification for Pi 0.80.6 on macOS, Ubuntu 24.04, and Windows Server 2025.
- Package-content, compatibility, advisory, license, secret-scanning, SBOM, CodeQL, and release-candidate gates.
