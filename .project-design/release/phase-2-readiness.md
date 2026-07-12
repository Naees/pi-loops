# Phase 2 Scheduling Readiness

**Date:** 2026-07-12
**Status:** In progress; public scheduling remains disabled

## Implemented internal foundations

- Strict schedule record schema and separate short-lived schedule-store lease.
- Project-bound one-off and recurring definitions.
- Pure parsing for `in <duration>`, `at HH:MM`, and `every <duration>`.
- Five-minute recurring minimum, canonical ISO persistence, and timing-grid validation.
- Startup missed-occurrence discard without backlog replay.
- One pending coalesced occurrence per recurring schedule.
- In-process timers, serialized local occurrences, and shutdown cancellation.
- Bounded production RPC client and macOS/Pi 0.80.6 worker manager.
- Fail-closed documented RPC UI relay.
- Git worktree/review-branch creation, clean-tree enforcement, commit preservation, and no auto-merge.
- Scheduled run state/evidence/evaluation orchestration with two-phase review-commit/worktree persistence.
- Strict unattended worker metadata and retention exclusion for unresolved worktrees.
- Cross-process repository-writer guards keyed by hashed canonical Git common directories, shared by attended and unattended controllers within one Pi data root while preserving project-keyed storage leases. Non-Git attended runs remain project-locked and are not dynamically reclassified if repository topology changes mid-run.

## Deliberate public boundary

`/loops schedule` and `pi_loops schedule` remain disabled in the extension. README and the packaged skill continue to describe scheduling as planned. Internal Phase 2 modules are packaged for testing but are not reachable through the public command/tool surface.

This boundary remains until the blockers below are resolved and a packed scheduling E2E passes.

## Remaining blockers

- Repository-writer coordination across Pi processes intentionally configured with different Pi data roots; the canonical Git guard currently coordinates all normal processes sharing one data root.
- Cross-process live schedule-claim ownership so a second Pi process cannot reconcile a live claim as stale.
- Scheduled run restart/resume that validates and reuses run ID, branch, worktree, and Pi session.
- Production-process descendant cleanup tests using `RpcWorkerClient`/`RpcWorkerManager`, not only the lifecycle spike client.
- Product schedule confirmation/status/delete behavior tests before enabling public UX.
- Real packed macOS scheduled writer E2E proving review-branch output, active-branch isolation, shutdown, and restart behavior.
- Linux and Windows runtime validation before either platform is claimed.

## Current validation

- `npm run check`: passed (strict source/script typechecks; 178 tests).
- Five consecutive full-suite reruns: passed without flakes.
- `npm run test:coverage`: passed (85.67% lines, 74.52% branches); coverage was used to target evaluator, RPC, UI, scheduler, and unattended gaps rather than as a release threshold.
- `npm run test:packed`: passed; existing `/loops status` behavior restored.
- `npm run pack:inspect`: passed; 44 intended package files.
- `npm run test:e2e:attended`: passed.
- `npm run spike:rpc:lifecycle`: passed, including forced-parent-death cleanup 10/10 on macOS/Pi 0.80.6.
- `npm audit`: passed with zero vulnerabilities.
- `git diff --check`: passed.

## Review disposition

The internal components may continue to the next implementation slice. Public scheduling must remain disabled until all P0/P1 blockers above are resolved and the Phase 2 independent review gate passes.
