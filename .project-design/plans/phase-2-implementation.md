# Phase 2 Scheduling Implementation Plan

**Status:** In progress
**Platform claim:** macOS/Pi 0.80.6 only for unattended execution until compatibility gates expand it.

## Decisions fixed for this phase

- Schedules execute only while Pi is running in their canonical creating project.
- Supported v1 expressions are `in <duration>`, `at HH:MM`, and `every <duration>`.
- Recurrence is an absolute interval anchored at creation; recurring cadence is at least the configured five-minute minimum.
- Missed occurrences are advanced/discarded at startup and never replayed.
- One running plus one coalesced pending occurrence is the maximum per schedule.
- One-off schedules remain persisted in `paused` state after completion or a missed occurrence; schedules are removed only through explicit deletion.
- Schedule-definition mutation uses a short-lived per-project schedule lease. Repository execution acquires a hashed guard keyed by the canonical Git common directory before the existing project-store lease; non-Git attended work retains project-only locking.
- Scheduled goals are treated as writers in v1; dirty or non-Git repositories pause in `awaiting_user` rather than attempting unsafe classification.
- Successful unattended work is committed on `pi-loops/<run-id>`, leaves the branch for review, removes only a confirmed-clean managed worktree, and never merges.
- Unknown/no-UI RPC dialogs never imply approval.

## Delivery slices

1. **Schedule domain and persistence**
   - Strict schedule types/schema, parser, coalescing transitions, schedule store, project binding, and tests.
2. **In-process scheduler**
   - Startup missed-run discard, timers, persisted claims, one pending occurrence, shutdown cancellation, and restart reconciliation.
3. **Unattended infrastructure**
   - Git worktree/review-branch manager, bounded production RPC transport, owned process shutdown, UI relay, and persisted worker identity.
4. **Scheduled-run controller**
   - Run creation, budgets, RPC work cycles, evidence/evaluation, finalization, interruption/resume, and one-writer enforcement.
5. **Public UX**
   - `/loops schedule`, schedule-aware status/delete, `pi_loops schedule`, normalized confirmation, docs, and skill updates.
6. **Phase gate**
   - Refactor, security review, real macOS packed E2E, forced-death regression, dirty/non-Git behavior, coalescing/restart tests, package audit, and independent review.

## Exit criteria

- One-off and recurring schedules persist and bind to one canonical project.
- Startup discards missed occurrences without a burst.
- Overlap produces at most one pending occurrence.
- Two processes cannot claim the same occurrence or overlap repository writers.
- Shutdown stops active children before returning.
- Dirty/non-Git projects preserve state and request user action.
- Successful code is reviewable on a retained branch and never auto-merged.
- Interrupted work reuses run ID, branch, worktree, and session.
- No scheduling or platform behavior is claimed without packed/runtime evidence.
