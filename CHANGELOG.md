# Changelog

All notable changes to this project will be documented here.

The project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Approved product and architecture design.
- Initial Pi package and test scaffolding.
- Typed run state, budgets, no-progress detection, completion contracts, and evidence collection.
- Strict configuration parsing, atomic run storage, writer leases, and retention primitives.
- Fresh current-model evaluator adapter with deterministic verifier precedence.
- Bounded RPC framing, child watchdog, packed-install validation, and lifecycle spikes.
- Attended goal loops with `/loops` and `pi_loops` goal, status, stop, resume, clean, and delete behavior.
- Deterministic verifier collection, fresh completion evaluation, hard active-time limits, budget epochs, interruption recovery, and real-session E2E validation.
- Packaged `pi-loops` skill for natural-language attended-goal activation.
- Deterministic macOS RPC lifecycle spike covering settlement, streaming/tool aborts, parent death, descendant cleanup, session/worktree resume, and UI relay.
- Fail-closed current-Pi launch resolution for Node CLI and standalone executable layouts without PATH search.
- Phase 2 scheduling with natural time parsing, normalized confirmation, project-bound persistence, missed-run discard, overlap coalescing, restart support, and shutdown-aware timers.
- Internal bounded RPC worker transport, fail-closed UI relay, isolated Git worktrees, review-branch finalization, and scheduled-run orchestration.
- Phase 3 proactive triggers with confirmed project-contained filesystem watches, strict namespaced event-bus payloads, model-facing firing of confirmed definitions, debounce, coalescing, restart recovery, and trigger claims.
- Phase 4 supply-chain checks for production advisories, reviewed SPDX licenses, CycloneDX SBOM validation, and high-confidence tracked-secret patterns.
- Non-publishing macOS release-candidate automation, minimum/current Node CI, CodeQL analysis, dependency review, package artifacts, and checksums.
- Explicit sequential stored-state migration infrastructure, frozen version-one compatibility fixtures, and packed upgrade/uninstall/reinstall validation.
- Packaged operations and strict integration documentation, public/provenance publish metadata, checksummed package inventories, and a non-publishing npm publication dry-run gate.

### Changed

- Consolidated attended-run initialization, UTF-8 record truncation, and npm package-boundary checks.
- Separated extension command parsing and presentation, centralized record-file I/O and error normalization, and isolated scheduled restart preparation from execution.
- Generalized unattended execution so scheduled and proactive writers share worktree isolation, RPC lifecycle, finite budgets, repository guards, and review-branch finalization.
- Bounded event ingress, error notifications, filesystem watcher admission, JSON record reads, and per-project trigger definitions; coordinated shutdown now attempts every safety cleanup before reporting failures.
- Pinned every external GitHub Action to a tested immutable commit and made mutable workflow references fail the security policy.
- Split extension hosts, routing, trigger-event relay, trigger ingress, and unattended definition/restart logic into focused internal modules; centralized repeated ID allocation, lease scoping, and record validation.

### Fixed

- The lockfile now supports clean installation with the minimum Node 22.19 toolchain's npm 10 as well as current npm.
- Malformed-response RPC tests now pass fixture envelopes as data rather than interpolating serialized values into child source code.
- Notice, lease, project-manifest, and current-Pi manifest reads now enforce their byte ceilings through the single-handle bounded reader, closing growth-after-stat and unbounded-read paths.
- Terminal attended runs now release their writer lease even if persistence, transcript, or notification callbacks fail.
- Stored evaluator decisions now enforce the same semantic invariants as fresh evaluator responses.
- An armed child-watchdog termination escalation is no longer disarmed during session shutdown.
- Immediate scheduled resume now waits for a locally settled occurrence to release its claims, eliminating a resume race.
- Run deletion now removes the run's deterministic Pi Loops-managed child-session directory while preserving unmanaged paths.
- RPC worker startup rejects empty session IDs, reported session directories, and reported or resumed session symlinks.
- Already-aborted worker UI requests and empty select options now fail closed before invoking parent UI callbacks.
