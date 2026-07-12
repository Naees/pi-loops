# Phase 3 Proactive Trigger Implementation Plan

**Status:** Complete for the validated macOS/Pi 0.80.6 scope
**Platform claim:** unattended trigger execution inherits the existing macOS/Pi 0.80.6 gate; trigger definition and validation are platform-neutral.

## Fixed contract

- Trigger definitions are project-bound, persisted user-locally, and active only while Pi is running in that project.
- `/loops watch <project-path> -- <goal>` creates a confirmed filesystem trigger.
- `/loops watch event -- <goal>` creates a confirmed event-bus trigger.
- Other extensions emit the documented `pi-loops:trigger` event with `{ schemaVersion: 1, triggerId, eventId? }`; payloads cannot inject goals, paths, budgets, or commands.
- `pi_loops action=trigger triggerId=<id>` fires an existing confirmed trigger definition.
- Filesystem paths are canonical, contained by the creating project, and watched only after `session_start`.
- Filesystem changes are debounced. Trigger activity coalesces to at most one pending occurrence per definition.
- Triggered writers reuse the Phase 2 worktree, RPC, review-branch, budget, evaluator, writer-lock, restart, and cleanup boundaries.
- Trigger definitions remain enabled after completed or interrupted occurrences until explicitly paused or deleted.
- No network listeners, polling, vendor credentials, or vendor-specific adapters enter core.
- Unknown fields, malformed IDs, oversized strings, hostile paths, and malformed event payloads fail closed.

## Delivery slices

1. Trigger IDs, strict schema, atomic store, and pure coalescing transitions.
2. Trigger controller with cross-process occurrence claims, debounce-safe firing, restart, stop, shutdown, and stale-state reconciliation.
3. Canonical contained filesystem watcher lifecycle and namespaced event-bus adapter.
4. Generalize unattended execution to persist `mode: proactive` and `triggerId` while preserving the schedule API.
5. Public watch/trigger/status/stop/resume/delete UX, confirmation, skill, README, and event contract documentation.
6. Unit, integration, hostile-payload, trigger-storm, cross-process, shutdown, packed-install, and macOS unattended E2E gates; then refactor and independent security review.

## Exit criteria

- Filesystem and event-bus triggers fire bounded proactive runs only while Pi is open.
- Trigger storms produce at most one running and one pending occurrence per definition.
- Competing Pi processes cannot execute the same trigger occurrence concurrently.
- Different proactive and scheduled writers never overlap in one repository.
- Shutdown closes watchers, cancels debounce timers, stops active workers, and releases claims.
- Hostile payloads and escaping/symlinked paths fail closed.
- Successful work remains on a review branch and is never auto-merged.
- Interrupted proactive work resumes with the same run, branch, worktree, and session; stalled/exhausted work starts a new finite epoch.
- Packed and runtime evidence supports every public Phase 3 claim.
