# Phase 0 Foundation Review

**Date:** 2026-07-12  
**Status:** Foundation in progress; macOS RPC lifecycle gate passed, Phase 0 is not cross-platform complete.

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
- 89 unit/integration tests pass, along with strict source and spike-script typechecks.
- npm package inspection and packed-tarball installation pass; the packed extension loads `/loops` in a clean temporary Pi home.
- `npm audit` reports no known vulnerabilities.
- Live Pi 0.80.6 RPC registration exposes `/loops` from the local extension.
- Child Pi RPC handshake, controlled active-bash cancellation, clean stdin-close exit, and independent absolute-deadline termination pass on macOS.
- A deterministic supported-provider fixture proves real agent settlement, streaming abort, model-initiated tool abort, and descendant cleanup on macOS.
- Parent `SIGINT`/`SIGTERM` ownership cleanup passes; forced parent `SIGKILL` leaves no Pi/tool descendants in ten consecutive macOS runs.
- Persistent Pi session resume in the same isolated Git worktree and RPC extension UI confirmation relay pass.
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

## RPC lifecycle follow-up

The macOS lifecycle spike now covers a controlled agent prompt and `agent_settled`, abort during model streaming, abort during a model-initiated built-in bash tool, process-group cleanup, parent `SIGINT`/`SIGTERM`, ten abrupt-parent-death runs, same-worktree session resume, and documented extension UI response relay. It also corrected the child watchdog so an armed forced-termination timer cannot be disarmed by `session_shutdown`.

Detailed evidence is in `.project-design/spikes/rpc-worker-report.md`.

## Remaining Phase 0 blockers

- Multi-process and crash-focused `proper-lockfile` lease stress validation.
- Compatibility execution of the fail-closed current-Pi resolver across npm-global and standalone/binary installation layouts.
- Linux and Windows process behavior before either platform is claimed.
- Product-specific permission/UI integration when the production unattended runner exists; silence must never approve.
- Evaluator cancellation-race and provider-error integration cases.

The macOS RPC lifecycle gate is now sufficient to continue the next implementation slice. Phase 0 remains cross-platform incomplete, and no Linux or Windows support may be claimed from code inspection alone.

No scheduling or proactive writing feature may be enabled until the applicable production runner, isolation, and phase review gates are also complete.
