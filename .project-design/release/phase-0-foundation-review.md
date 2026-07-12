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
- Atomic JSON replacement helper and pure 50-run retention selection.
- Strict bounded LF JSONL RPC decoder.
- Parent extension registration shell and child recursion suppression.
- Package inventory inspection and initial idle RPC handshake spike.

## Validation completed

- TypeScript strict typecheck passes.
- 27 unit/integration tests pass.
- npm package inspection passes and excludes tests and internal design material.
- `npm audit` reports no known vulnerabilities.
- Live Pi 0.80.6 RPC registration exposes `/loops` from the local extension.
- Idle child Pi RPC handshake and clean stdin-close exit pass on macOS.

## Independent review findings addressed

- Reworked the RPC spike to use the bounded JSONL decoder, discard processed output, cap stderr, validate the Pi executable, and escalate termination.
- Removed the not-yet-functional skill from the package manifest and npm tarball.
- Added strict unknown-key/type/shape configuration parsing.
- Added explicit recoverable versus permanent failure state.
- Added exhaustive approved-transition tests.

## Remaining Phase 0 blockers

- Production writer lease and stale-owner recovery.
- Evaluator adapter spike with existing Pi authentication.
- Packed-tarball install/load harness.
- RPC abort during model and tool execution.
- Parent-death watchdog and descendant-process cleanup.
- Session/worktree resume.
- RPC permission/UI relay.
- Linux and Windows process behavior.
- Production executable-resolution strategy across Pi installation modes.

No scheduling or proactive writing feature may be enabled until the applicable RPC lifecycle blockers are proven.
