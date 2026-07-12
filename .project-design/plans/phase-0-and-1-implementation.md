# Implementation Plan

## Goal
Deliver the smallest production-quality Pi Loops vertical slice: an installable Pi package with durable typed run state, `/loops` and `pi_loops`, bounded attended goal cycles, a fresh-evaluator seam, and a proven RPC child-process foundation without making `pi-subagents` mandatory.

## Tasks

1. **Create the package and release boundary first**
   - Files: `package.json`, `package-lock.json`, `tsconfig.json`, `LICENSE`, `CHANGELOG.md`, `SECURITY.md`, `.gitignore`, `scripts/inspect-pack.mjs`, `scripts/release-check.mjs`
   - Changes:
     - Declare `@naees/pi-loops`, Node `>=22.19.0`, `pi-package` metadata, `pi.extensions`, `pi.skills`, and a strict npm `files` whitelist.
     - Keep Pi libraries and `typebox` as `"*"` peer dependencies per Pi package guidance; pin matching versions only in `devDependencies` for typecheck/test reproducibility.
     - Add scripts for typecheck, unit tests, packed-artifact inspection, and release checks that reject `.project-design/` and `.pi-subagents/` in the tarball.
     - Keep `pi-subagents` absent from dependencies, peers, and bundled dependencies.
   - Acceptance:
     - `npm install`, typecheck, and an initial empty test run work.
     - `npm pack --dry-run` exposes only intended public resources.
     - Package installation does not require `pi-subagents`.

2. **Define stable domain types and state transitions before Pi integration**
   - Files: `src/shared/types.ts`, `src/shared/errors.ts`, `src/shared/ids.ts`, `src/controller/state-machine.ts`, `src/controller/budgets.ts`, `src/controller/no-progress.ts`, `tests/unit/state-machine.test.ts`, `tests/unit/budgets.test.ts`, `tests/unit/no-progress.test.ts`, `tests/unit/ids.test.ts`
   - Changes:
     - Model run IDs, goal contracts, evidence, evaluator decisions, budget epochs, usage, terminal reasons, and all approved run states.
     - Encode allowed transitions as a pure transition function; illegal transitions must throw a typed error.
     - Implement confirmed defaults: 15 outer cycles, three hours active time, three equivalent no-progress cycles, and finite overrides only.
     - Generate short user-facing IDs with cryptographically strong randomness and explicit prefixes.
   - Acceptance:
     - Every approved transition is tested; forbidden transitions fail deterministically.
     - Time paused outside Pi does not consume active budget.
     - Budget exhaustion and stall signatures are reproducible.

3. **Implement versioned configuration with explicit precedence**
   - Files: `src/config/schema.ts`, `src/config/load.ts`, `tests/unit/config.test.ts`, `tests/fixtures/config/`
   - Changes:
     - Validate `pi-loops.config.v1` strictly.
     - Merge built-ins → user config → project config → invocation overrides.
     - Reject invalid safety-critical limits instead of silently falling back.
     - Resolve the project config using Pi's `CONFIG_DIR_NAME`; isolate user-data-path derivation behind one function pending the storage-path spike.
   - Acceptance:
     - Precedence and malformed-input cases are exhaustively tested.
     - No project config is created automatically.
     - All resulting runs have finite cycle and wall-time limits.

4. **Build atomic user-local storage and bounded retention**
   - Files: `src/storage/paths.ts`, `src/storage/atomic-file.ts`, `src/storage/store.ts`, `src/storage/lease.ts`, `src/storage/retention.ts`, `src/storage/migration.ts`, `tests/unit/storage.test.ts`, `tests/unit/lease.test.ts`, `tests/unit/retention.test.ts`
   - Changes:
     - Store one schema-versioned record per run, with indexes rebuildable from source records.
     - Write through same-directory temporary files plus atomic rename; set restrictive permissions where supported.
     - Implement ownership-token writer leases; do not trust PID alone.
     - Reconcile stale `running` records to `interrupted` at startup.
     - Keep at most 50 eligible terminal runs per project; completely delete the least-recently-used record with no tombstone. Exclude active/interrupted/queued/unresolved-worktree runs.
   - Acceptance:
     - Crash simulation never exposes partial primary JSON.
     - Concurrent lease acquisition permits one owner.
     - The 51st eligible terminal run deletes exactly the expected oldest record.
     - No environment variables, credentials, or chain-of-thought are persisted.

5. **Create the Pi extension entrypoint and public registration shell**
   - Files: `src/extension/index.ts`, `src/commands/loops-command.ts`, `src/tools/pi-loops-tool.ts`, `src/ui/status.ts`, `skills/pi-loops/SKILL.md`, `tests/integration/registration.test.ts`
   - Changes:
     - Register `/loops`, the `pi_loops` tool, session lifecycle handlers, and namespaced custom entries.
     - Implement Phase 1 subcommands/actions only: `goal`, `status`, `stop`, and `resume`; return clear “not implemented in this phase” results for schedule/trigger rather than silently accepting them.
     - Detect `PI_LOOPS_CHILD` and enter non-recursive worker mode without registering the outer controller.
     - Inspect `pi.getAllTools()` only for optional capability messaging; never treat metadata as executable access.
     - Show the `pi-subagents` recommendation once, without blocking.
   - Acceptance:
     - A Pi extension fixture proves command/tool names and child-mode suppression.
     - Package works when no `subagent` tool is present.
     - Duplicate command provenance produces a clear diagnostic rather than ownership guessing.

6. **Implement completion contracts and normal-Pi evidence collection**
   - Files: `src/contracts/completion-contract.ts`, `src/contracts/inference.ts`, `src/evidence/collector.ts`, `src/evidence/verifier.ts`, `tests/unit/completion-contract.test.ts`, `tests/unit/evidence.test.ts`
   - Changes:
     - Prefer explicit criteria; define a narrow inference interface for project-derived criteria without creating a general project-analysis framework.
     - Observe `tool_execution_*`, `turn_end`, and `agent_settled` events to correlate required verifier commands/results.
     - Treat failed or missing required evidence as incomplete and cap stored output.
     - Do not execute arbitrary user verifier commands through `pi.exec`; request them through the normal agent/tool flow so Pi's existing permission behavior remains authoritative.
   - Acceptance:
     - Failed/missing evidence cannot become complete.
     - Evidence is correlated by tool-call ID and bounded before persistence.
     - Tests cover parallel tool completion ordering.

7. **Add a fresh evaluator seam before wiring the controller**
   - Files: `src/evidence/evaluator.ts`, `src/evidence/evaluator-schema.ts`, `tests/unit/evaluator.test.ts`, `tests/integration/evaluator.test.ts`
   - Changes:
     - Define an injectable evaluator interface returning strict structured decisions.
     - Implement the production adapter with `@earendil-works/pi-ai/compat` `complete()`, `ctx.model`, and `ctx.modelRegistry.getApiKeyAndHeaders()`.
     - Send only goal, constraints, bounded evidence, worker summary, and prior concise feedback; never forward chain-of-thought.
     - Make cancellation win over a late evaluator response.
   - Acceptance:
     - Unit tests use a fake evaluator with accept/reject/needs-user/error outcomes.
     - Integration test verifies missing model/auth produces a typed recoverable error.
     - Deterministic verifier failure bypasses evaluator acceptance.

8. **Wire the attended goal-loop vertical slice**
   - Files: `src/controller/controller.ts`, `src/controller/goal-loop.ts`, updates to `src/commands/loops-command.ts`, `src/tools/pi-loops-tool.ts`, `src/extension/index.ts`, `tests/integration/goal-loop.test.ts`, `tests/e2e/attended-goal.test.ts`
   - Changes:
     - Start an attended run in the current session/tree, persist it, inject the first bounded work instruction, and end each outer cycle only on `agent_settled`.
     - Transition `running → verifying → evaluating → running/finalizing/awaiting_user/stalled/budget_exhausted` deterministically.
     - Use `pi.sendUserMessage(..., { deliverAs: "followUp" })` only when required by Pi's streaming state; guard against extension-injected input retriggering a second run.
     - Implement `/loops status`, `/loops stop`, and explicit/unambiguous `/loops resume` for the supported recoverable states.
     - Append concise namespaced session entries while keeping full records user-local.
   - Acceptance:
     - Fake-Pi integration tests prove multiple rejected cycles, acceptance, cancellation, stall, exhaustion, and resume.
     - Exactly one outer cycle is counted per settled Pi run.
     - A late evaluator cannot restart a cancelled run.

9. **Run the mandatory RPC worker spike as an isolated, non-product experiment**
   - Files: `src/worker/rpc-jsonl.ts`, `src/worker/pi-executable.ts`, `scripts/spike-rpc-worker.mjs`, `tests/unit/rpc-jsonl.test.ts`, `.project-design/spikes/rpc-worker-report.md`
   - Changes:
     - Implement strict LF-delimited JSONL parsing without Node `readline`; bound line/buffer sizes and reject malformed messages.
     - Test candidate current-Pi resolution for npm-installed and binary layouts.
     - Spawn Pi with `shell: false`, cwd set to a temporary Git worktree, `PI_LOOPS_CHILD` set, and prompts sent only through RPC stdin.
     - Exercise `get_state`, prompt acceptance with a no-op/mock-safe task if credentials permit, `agent_settled`, RPC abort, stdin close, normal termination, timeout escalation, and parent-death behavior.
     - Record observed behavior and OS limitations in the internal spike report; do not expose scheduling yet.
   - Acceptance:
     - JSONL parser tests cover chunk boundaries, CRLF tolerance, U+2028/U+2029, oversized records, and malformed JSON.
     - Spike proves clean handshake/exit and no prompt in argv on the development platform.
     - Failure to prove no-orphan behavior blocks Phase 2 but does not block the attended Phase 1 slice.

10. **Add packed-install and release-boundary validation**
    - Files: `tests/e2e/packed-install.test.ts`, `scripts/inspect-pack.mjs`, `scripts/release-check.mjs`, CI files only if the local slice is green
    - Changes:
      - Build an npm tarball, inspect paths, install it into a temporary `PI_CODING_AGENT_DIR`, and load the extension without repository-local dependencies.
      - Test with `pi-subagents` absent; add a capability-only test with a fake or separately installed `subagent` tool.
      - Reject `.project-design/`, `.pi-subagents/`, raw tests, secrets, and unlisted artifacts.
    - Acceptance:
      - Clean tarball install registers `/loops`, `pi_loops`, and the skill.
      - Core attended goal behavior works without `pi-subagents`.
      - Release check fails on injected forbidden artifacts.

11. **Refactor and review before Phase 2**
    - Files: affected Phase 0/1 files; `.project-design/release/phase-1-readiness.md`
    - Changes:
      - Remove duplication, split Pi adapters from pure domain logic, review error/state names, and ensure tests describe the public contract.
      - Run a focused security review of path handling, persisted data, command construction, evaluator context, and cancellation races.
      - Update public README only for behavior that actually works; keep future schedule/proactive features clearly marked planned.
    - Acceptance:
      - Typecheck, unit, integration, packed E2E, and audit checks pass.
      - No scheduling/proactive code is enabled before the RPC spike and Phase 2 review.
      - Working tree has no staged or generated artifacts after validation.

## Files to Modify

- `README.md` - replace planned wording only as Phase 1 behavior becomes real.
- `.project-design/brief/product-design.md` - do not make runtime-dependent edits; append/reopen decisions only if spike evidence changes the contract.
- `.project-design/spikes/rpc-worker-report.md` - internal spike evidence.
- `.project-design/release/phase-1-readiness.md` - Phase 1 review record.

## New Files

- Root package, license, policy, TypeScript, lockfile, release scripts, and CI files listed above.
- `src/` pure domain, Pi adapter, evaluator, storage, and RPC framing modules listed in Tasks 2–9.
- `skills/pi-loops/SKILL.md` for natural-language activation.
- Unit, integration, RPC, packed E2E, and fixture files listed in Tasks 2–10.

## Dependencies

- Tasks 2–4 depend on Task 1.
- Task 5 depends on domain types and config from Tasks 2–3.
- Tasks 6 and 7 depend on Tasks 2–5 but can proceed in parallel once shared types stabilize.
- Task 8 depends on Tasks 4, 6, and 7.
- Task 9 depends only on Task 1 plus shared RPC types and can run in parallel with Tasks 4–8; its result gates Phase 2, not attended Phase 1.
- Task 10 depends on Tasks 5 and 8.
- Task 11 depends on all Phase 0/1 tasks and is the Phase 1 exit gate.

## API and Dependency Pitfalls

- Pi package docs require Pi core packages and `typebox` as `"*"` peers; runtime cannot rely on `devDependencies` because Pi installs production dependencies.
- `pi.getAllTools()` supplies metadata/provenance, not a callable implementation. Never attempt to invoke `subagent` through it.
- `pi-subagents` has no supported JS `main`/`exports`; importing private paths or bundling its extension would violate the chosen boundary and risk duplicate registrations.
- `agent_end` is too early because retries/compaction/follow-ups may remain; outer cycles must close on `agent_settled`.
- `pi.sendUserMessage()` requires a delivery mode while streaming and can create reentrancy if extension-originated input is not tagged/guarded.
- `@earendil-works/pi-ai/compat` evaluator calls need both selected model and resolved API key/headers; they must be abortable and separately mocked.
- RPC framing is strict LF JSONL; Node `readline` is explicitly unsuitable because it splits Unicode separators.
- Closing an RPC stdin pipe, aborting active tools, and killing descendant processes have OS-specific behavior; no scheduling claim is safe until measured.
- State-path derivation is not a documented generic extension-data API; isolate it and validate `PI_CODING_AGENT_DIR`/Pi configuration behavior before freezing paths.
- Atomic rename alone does not serialize multiple Pi processes; a tokenized lease is required, and stale PID reuse must not transfer ownership.
- Package tarballs must exclude `.project-design/` from the first pack test even though it remains in the development checkout.

## Risks

- The fresh evaluator may accept incomplete work; deterministic evidence must remain authoritative.
- Tool calls from other extensions may not expose standard result details; unknown evidence must be treated as missing rather than inferred.
- A user can install another `/loops` command; Pi may suffix duplicates, so provenance diagnostics and E2E collision tests are required.
- Retention deletion is irreversible and intentionally leaves no tombstone; only eligible terminal runs may enter LRU eviction.
- RPC no-orphan behavior may fail on Windows or for descendant processes; platform support must remain unclaimed until proven.
- The `@naees` npm scope appears unregistered but publication rights are not yet proven.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Produced a scope-bounded Phase 0/1 implementation plan covering the requested package skeleton, typed primitives, registrations, goal cycle, evaluator seam, tests, and RPC spike while keeping pi-subagents optional."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "The plan names exact files, ordered dependencies, API pitfalls, test obligations, and explicit acceptance/exit criteria for independent review."
    }
  ],
  "changedFiles": [
    "/tmp/.pi-subagents/artifacts/outputs/5c7ff336-a4d6-4eb8-9fd8-b8ad2a2c09b7/plan.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [],
  "validationOutput": [
    "Read and incorporated the approved product-design brief from /Users/naees/Code/loops/.project-design/brief/product-design.md.",
    "No repository files were modified."
  ],
  "residualRisks": [
    "RPC process-tree and no-orphan behavior remains a mandatory implementation spike.",
    "Exact Pi user-data path derivation and npm scope publication access remain unverified.",
    "Provisional turn/tool budget calibration requires realistic migration testing."
  ],
  "noStagedFiles": true,
  "diffSummary": "Planning artifact only; repository unchanged.",
  "reviewFindings": [
    "no blockers in the plan; Phase 2 must remain gated on the RPC spike"
  ],
  "manualNotes": "Keep pi-subagents capability detection informational only; do not import, bundle, or require it."
}
```
