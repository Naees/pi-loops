# ADR-006 — Runtime deletion versus append-only Pi session history

**Status:** Accepted during Phase 1 implementation  
**Date:** 2026-07-12

## Context

The approved retention decision requires complete removal of an evicted run ID and its managed runtime data, with no tombstone. Pi Loops also mirrors concise state into the parent Pi session. Pi sessions are append-only through the supported extension API: extensions can append custom entries but cannot delete earlier commands, assistant messages, tool results, or custom entries.

A goal invoked through `/loops` or `pi_loops` is inherently present in the parent transcript even if Pi Loops appends no custom entry.

## Decision

`/loops delete` and automatic retention delete all data managed by the Pi Loops runtime store for that run:

- Run record and ID index.
- Stored evidence and evaluator decisions.
- Managed logs and child-session data when those exist.
- Managed worktree metadata, subject to the separate rule that project code and branches are never silently deleted.

Deletion does not claim to erase:

- The append-only parent Pi transcript.
- Commands or agent/tool messages already in that transcript.
- Project files, commits, or branches.

New Pi Loops custom session entries contain only run ID, state, cycle counts, and timestamp. They omit goal text, evidence, and terminal details to minimize immutable duplication.

## Consequences

- Public documentation must describe this boundary explicitly.
- No tombstone remains in Pi Loops' own runtime store.
- A saved deleted run ID returns `not found` even though the text may still appear in historical conversation entries.
- A future supported Pi session-redaction API may permit optional deeper deletion, but Pi Loops will not edit Pi session JSONL files directly.
