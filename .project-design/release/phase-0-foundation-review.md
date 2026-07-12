# Phase 0 Foundation Review

**Date:** 2026-07-12  
**Status:** Foundation in progress; Phase 0 is not complete.

## Implemented foundation

- npm Pi package manifest with a strict public-file whitelist.
- Reproducible TypeScript/Vitest toolchain and lockfile.
- Pure run-state machine and recoverability distinction.
- Confirmed default configuration and strict configuration-boundary parsing.
- Active-time/cycle budget accounting.
- Equivalent-failure no-progress signatures.
- Cryptographic run/schedule IDs and stable project IDs.
- Atomic JSON replacement helper, ownership-token writer leases, stale-lease quarantine, and pure 50-run retention selection.
- Strict bounded LF JSONL RPC decoder.
- Current-model evaluator adapter with strict structured decisions.
- Packed-tarball install and live extension-load harness.
- Parent extension registration shell and child recursion suppression.
- Package inventory inspection and initial idle RPC handshake spike.

## Validation completed

- TypeScript strict typecheck passes.
- 49 unit/integration tests pass.
- npm package inspection and packed-tarball installation pass; the packed extension loads `/loops` in a clean temporary Pi home.
- `npm audit` reports no known vulnerabilities.
- Live Pi 0.80.6 RPC registration exposes `/loops` from the local extension.
- Child Pi RPC handshake, controlled active-bash cancellation, clean stdin-close exit, and independent absolute-deadline termination pass on macOS.
- The current-model evaluator resolves existing Pi authentication and returns a strict completion decision.

## Independent review findings addressed

- Reworked the RPC spike to use the bounded JSONL decoder, discard processed output, cap stderr, validate the Pi executable, and escalate termination.
- Removed the not-yet-functional skill from the package manifest and npm tarball.
- Added strict unknown-key/type/shape configuration parsing.
- Added explicit recoverable versus permanent failure state.
- Added exhaustive approved-transition tests.
- Replaced the hand-rolled lease update/delete protocol with `proper-lockfile` serialization and required an active project lease at every run-store mutation boundary.
- Made deterministic verifier failure authoritative before any model evaluation.
- Expanded crash reconciliation to every persisted transient state.
- Bounded evaluator-spike RPC buffering and strengthened RPC request/response correlation.
- Tightened candidate command inference so backticked filenames are not treated as verifier commands.

## Remaining Phase 0 blockers

- Multi-process and crash-focused `proper-lockfile` lease stress validation.
- RPC abort during model streaming and model-initiated tool execution.
- Parent-death watchdog and descendant-process cleanup.
- Session/worktree resume.
- RPC permission/UI relay.
- Linux and Windows process behavior.
- Production executable-resolution strategy across Pi installation modes.
- Evaluator cancellation-race and provider-error integration cases.

A follow-up independent review found no remaining blocker or high-severity issue in the implemented foundation. Phase 0 remains incomplete because the lifecycle and cross-platform items above are still open.

No scheduling or proactive writing feature may be enabled until the applicable RPC lifecycle blockers are proven.
