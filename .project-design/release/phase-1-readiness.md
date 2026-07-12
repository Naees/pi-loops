# Phase 1 Attended Goal Readiness

**Date:** 2026-07-12  
**Status:** Phase 1 complete; independent review gate passed

## Implemented public behavior

- `/loops goal <goal>` starts one bounded attended goal in the current Pi session and checkout.
- `/loops status` lists recent project-local runs.
- `/loops stop [run-id]` aborts and cancels the active goal.
- `/loops resume [run-id] [guidance]` restores interrupted, stalled, exhausted, recoverably failed, or awaiting-user goals with a new budget epoch.
- `/loops clean` enforces the 50-terminal-run retention policy.
- `/loops delete <run-id>` requires interactive confirmation and deletes one stored runtime record.
- The `pi_loops` tool exposes goal, status, stop, and resume actions.
- The packaged `pi-loops` skill provides natural-language activation guidance.

## Controller behavior

- One project writer lease is held for an active attended goal.
- Explicit verifier commands are authoritative and are observed from normal Pi `tool_result` events.
- Missing or failing required evidence bypasses model evaluation and forces another cycle or terminal bounded outcome.
- Passing evidence is evaluated through a fresh current-model call.
- One outer cycle is counted per `agent_settled` event.
- Active wall time has an independent timer and aborts a cycle that does not settle before its limit.
- Equivalent failures stall after the configured threshold.
- Cycle or active-time exhaustion is recoverable with a new finite budget epoch.
- Session shutdown persists `interrupted` and releases the writer lease.
- Full run records are stored user-locally; concise state is appended to the Pi session.

## Validation

- Strict TypeScript typecheck passes.
- 70 unit/integration tests pass.
- Packed-tarball installation loads `/loops`, executes `/loops status`, and includes the skill.
- A real authenticated Pi RPC end-to-end goal installed the packed tarball as a Pi package, discovered the packaged skill, invoked the model-facing `pi_loops` tool from natural language, passed an exact deterministic verifier command, and made no project modifications.
- npm package inspection excludes tests and internal design files.
- npm audit reports no known vulnerabilities.

## Deliberately deferred

- Scheduled and proactive loops.
- Unattended worktree writers.
- Project/user configuration file loading; built-in and per-tool invocation budgets work now.
- Vendor-specific integrations.
- Public npm release.

## Review findings addressed

- Clarified that runtime deletion cannot erase Pi's append-only parent transcript; minimized immutable custom entries and documented ADR-006.
- Bounded worker summaries, evaluator output, evaluator arrays, and complete run-record file size before persistence/parsing.
- Added bounded retries for transient evaluator failures.
- Added terminal reason and deterministic evidence summaries to persisted status output.
- Upgraded real E2E to install the packed tarball, load package resources, discover the skill, and start the goal through the model-facing tool.
- Added startup/status crash reconciliation and lease-protected status recency updates.
- Added command collision diagnostics and active tool-registration checks.
- Persisted the one-time optional `pi-subagents` recommendation.
- Unified contract/storage limits in UTF-8 bytes, fixed truncation to remain inside its storage ceiling, and added oversized multibyte regression tests.
- Verified effective `pi_loops` tool provenance against this extension's path at startup.
- Added conservative project verifier inference for existing npm, Rust, Go, and Python test surfaces.

## Phase-boundary refactor

- Extracted pure formatting, truncation, budget resolution, deterministic-decision, prompt construction, and ID-allocation helpers from the attended controller into `attended-goal-support.ts`.
- Kept Pi API adaptation in the extension, stateful orchestration in the controller, and persistence/evidence/evaluation in dedicated modules.
- Re-ran the complete automated and real-session validation after refactoring.

## Final exit validation

- `npm run check`: passed (strict typecheck; 70 tests).
- `npm run test:packed`: passed (packed extension loaded and `/loops status` executed).
- `npm run pack:inspect`: passed (27 intended package files; internal design/tests excluded).
- `npm run test:e2e:attended`: passed using the packed package, discovered skill, natural-language model routing to `pi_loops`, exact deterministic verifier, fresh evaluator, and zero project modifications.
- `npm audit`: passed with zero known vulnerabilities.
- `git diff --check`: passed.
- Final independent post-refactor review: no blocker or high-severity regression; Phase 1 gate **PASS**.

Phase 1 is complete. Phase 2 scheduling remains gated by the remaining unattended RPC lifecycle and cross-platform requirements in the Phase 0 foundation report.
