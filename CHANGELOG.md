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
- Internal Phase 2 scheduling domain with natural time parsing, project-bound persistence, missed-run discard, overlap coalescing, and shutdown-aware timers; public scheduling remains gated.
- Internal bounded RPC worker transport, fail-closed UI relay, isolated Git worktrees, review-branch finalization, and scheduled-run orchestration.

### Changed

- Consolidated attended-run initialization, UTF-8 record truncation, and npm package-boundary checks.

### Fixed

- Terminal attended runs now release their writer lease even if persistence, transcript, or notification callbacks fail.
- Stored evaluator decisions now enforce the same semantic invariants as fresh evaluator responses.
- An armed child-watchdog termination escalation is no longer disarmed during session shutdown.
