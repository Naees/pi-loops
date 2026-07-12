# Phase 2 Scheduling Readiness

**Date:** 2026-07-12
**Status:** Complete for the validated macOS/Pi 0.80.6 scope

## Implemented

- Strict project-bound schedule persistence and normalized `in`, `at`, and `every` expressions.
- Five-minute recurring minimum, missed-occurrence discard, overlap coalescing, and retained one-off records.
- Cross-process occurrence and project-execution claims with stale takeover and compromise aborts.
- Per-user repository writer guards keyed by canonical Git common directories across Pi data roots.
- Isolated worktrees and `pi-loops/<run-id>` review branches with no automatic merge.
- Bounded production RPC transport, fail-closed UI relay, child watchdog, and descendant cleanup.
- Scheduled restart using the same run ID, validated branch/worktree, Pi session identity, deadline, and budget epoch; stalled or exhausted work starts a new finite epoch.
- Public `/loops schedule <expression> -- <goal>` and `pi_loops action=schedule`, both requiring normalized interactive confirmation.
- Schedule-aware status, stop, resume, delete, startup, and shutdown behavior.

## Platform boundary

Unattended scheduled writing is validated only on macOS with Pi 0.80.6. Linux and Windows remain unsupported until separately validated; no behavior on those platforms is claimed. Pi Loops schedules run only while Pi is open.

## Validation

- `npm run check`: passed (strict source/script typechecks; 194 tests).
- `npm run test:coverage`: passed; coverage is used to target behavior rather than as a release threshold.
- `npm run test:packed`: passed with the public extension loaded from the npm tarball.
- `npm run test:e2e:scheduled:packed`: passed with real Git isolation, review-branch output, active-tree preservation, and worktree cleanup from the packed package.
- `npm run test:rpc:lifecycle:production`: passed using production `RpcWorkerClient`, including model-initiated descendant cleanup, session resume, signals, and forced parent death 10/10 on macOS/Pi 0.80.6.
- Production `RpcWorkerManager` controlled-descendant cleanup test: passed.
- `npm run test:e2e:attended`: passed.
- `npm audit`: passed with zero vulnerabilities.
- `git diff --check`: passed.

## Disposition

Phase 2 is complete for the stated macOS/Pi 0.80.6 scope. Phase 3 proactive triggers may begin. Platform claims must not expand without separate runtime evidence.
