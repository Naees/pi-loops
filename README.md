# Pi Loops

> **Status: attended goals, scheduling, and proactive triggers are implemented and natively qualified on macOS, Linux, and Windows with Pi 0.80.6; no public npm release exists yet.**

Pi Loops is a [Pi](https://pi.dev) package for bounded loop engineering: clarify a goal, work, verify the result, evaluate completion, feed back failures, and retry until the goal succeeds or a declared limit is reached.

The project is designed around one rule:

> Pi Loops runs only while Pi is running. It is not a daemon or hosted automation service.

## Planned installation

The intended zero-setup installation is:

```text
pi install npm:@naees/pi-loops
```

Once published, it will require an existing working Pi installation with:

- An authenticated model/provider.
- A trusted project.
- The permissions needed by the requested coding task.
- Git for isolated scheduled or proactive code-writing runs.
- PowerShell 7 on Windows for kill-on-close Job Object lifecycle containment.

No Pi Loops configuration will be required for normal use.

Operational and integration references:

- [Operations, recovery, data, review branches, upgrades, and troubleshooting](docs/operations.md)
- [Strict extension event integration contract](docs/integrations.md)
- [Security policy and private reporting](SECURITY.md)

## Attended goal usage

### Natural language

```text
Keep fixing the authentication implementation until the auth tests pass.
Do not modify the tests.
```

### Explicit goal

```text
/loops goal Fix authentication until `npm test -- auth` passes.
Do not modify existing auth tests.
```

Goal loops run in the attended Pi session and current checkout. Scheduled and proactive writers run only while Pi is open, in isolated Git worktrees, and leave successful work on review branches without auto-merging.

## Loop modes

Pi Loops is delivered in phases:

1. **Turn-based verification and attended goal loops — implemented:** bounded cycles, deterministic evidence, fresh evaluation, status, stop, interruption, and resume.
2. **Scheduled loops — implemented:** trigger bounded goals at a time or interval while Pi is running (qualified on macOS, Linux, and Windows with Pi 0.80.6).
3. **Proactive loops — implemented:** trigger confirmed bounded goals from project filesystem changes, other Pi extensions, or the model-facing tool while Pi is running (qualified on macOS, Linux, and Windows with Pi 0.80.6).

## Completion model

A goal loop combines two forms of verification:

1. **Deterministic evidence**, such as a test command exiting successfully.
2. **Fresh model evaluation** for criteria that require judgment.

Required deterministic checks take precedence. A model evaluator cannot declare success while a required check is failing or missing.

The default attended-goal profile is:

- 3 hours of active execution.
- 15 outer work cycles.
- Stop after 3 equivalent no-progress cycles.
- One active writer per repository.

Runs end explicitly as completed, failed, cancelled, interrupted, stalled, or budget exhausted. Interrupted and bounded-failure runs can be resumed with a new finite budget.

### Operational limits

- New completion contracts allow a 16 KiB goal, at most 50 constraints, and at most 20 exact verifier commands; each constraint or command is limited to 4 KiB.
- Evaluator requests have an independent 128 KiB aggregate ceiling and evaluator responses are limited to 64 KiB. Pathological maximal combinations fail closed before provider invocation rather than silently dropping required evidence.
- Recurring schedules have a five-minute minimum. Missed occurrences are discarded and overlap retains only one pending occurrence.
- Projects may retain 50 trigger definitions. Filesystem debounce values range from 100 milliseconds to 60 seconds; process-local event ingress admits 64 trigger keys, one pending delivery per definition, and 128 remembered event IDs per trigger.
- RPC lines are limited to 1 MiB, retained worker events to 8 MiB and 10,000 events, and retained worker stderr to 64 KiB.
- Budget overrides must be positive safe integers and are not silently clamped. Pi Loops does not claim a provider monetary spending cap.

## Implemented command surface

```text
/loops goal <goal>
/loops schedule <time-expression> -- <goal>
/loops watch <project-path|event> -- <goal>
/loops status
/loops stop [run-id|schedule-id|trigger-id]
/loops resume [run-id|trigger-id] [guidance]
/loops clean
/loops delete <run-id|schedule-id|trigger-id>
```

The model-facing `pi_loops` tool exposes `goal`, `schedule`, `trigger`, `status`, `stop`, and `resume` actions, including optional explicit verifier commands, constraints, and finite budget overrides. `trigger` fires an existing user-confirmed trigger definition by ID; it cannot inject a new goal.

`/loops schedule <time-expression> -- <goal>` creates a confirmed project-bound schedule. `/loops watch <path> -- <goal>` creates a debounced filesystem trigger, while `/loops watch event -- <goal>` creates an event-bus trigger. `/loops clean` enforces bounded terminal-record retention; `/loops delete` requires confirmation and removes one stored run, schedule, or trigger record.

Each goal execution receives a run ID such as `run_a4f2`.

If only one run is resumable, `/loops resume` will not require its ID. If several qualify, Pi Loops will present a selector.

## Scheduled-writing isolation

Attended goals may work in the current checkout.

Scheduled and proactive writers use an isolated Git worktree and a namespaced branch such as:

```text
pi-loops/run-a4f2
```

Successful unattended work is left on that branch for review. Pi Loops never merges it automatically or modifies the user's active branch during finalization.

Unattended writing pauses when:

- The repository is not a Git repository.
- The working tree is dirty.
- A safe isolated worktree cannot be created.

Attended goals and read-only schedules can still operate in those cases.

## Proactive trigger contract

Filesystem triggers accept only existing canonical paths contained by the creating project. Changes are debounced, unattributed recursive events and Git metadata are ignored, and trigger storms coalesce to at most one pending occurrence. A project may store at most 50 trigger definitions. `/loops stop <trigger-id>` pauses a definition after cancelling its local active occurrence; `/loops resume <trigger-id>` re-enables it.

Other Pi extensions can fire a previously confirmed event trigger through Pi's shared event bus:

```ts
pi.events.emit("pi-loops:trigger", {
  schemaVersion: 1,
  triggerId: "trigger_a4f2c1d3",
  eventId: "optional-source-event-id",
});
```

The payload is strict and cannot supply a goal, verifier command, budget, path, credential, or vendor-specific data. Event ingress is bounded to one active and one pending delivery per definition; repeated optional `eventId` values are deduplicated for the current Pi process. Event adapters remain outside Pi Loops core.

## Process boundary

For isolated unattended work, Pi Loops starts a narrowly scoped child Pi process in documented RPC mode. The child:

- Use the existing Pi installation and model configuration.
- Run in the isolated worktree.
- Receive tasks through JSON stdin rather than shell interpolation.
- Have finite cycle and time limits.
- Stop when cancelled or when the parent Pi exits.
- Be prevented from recursively launching another Pi Loops child.

Native macOS, Linux, and Windows lifecycle gates with Pi 0.80.6 verify cancellation, crash cleanup, resume, descendant cleanup, and repeated forced-parent-death behavior. Windows workers additionally use a PowerShell 7 Job Object sentinel with kill-on-close containment.

## Optional `pi-subagents`

[`pi-subagents`](https://github.com/nicobailon/pi-subagents) is optional but highly recommended for parallel workers and independent review:

```text
pi install npm:pi-subagents
```

Pi Loops will not bundle, fork, or import private `pi-subagents` implementation files. The core package must work without it.

## Permissions and scope

Pi Loops relies on Pi's existing permission behavior. It does not add a second permission framework or become a general policy package.

Pi Loops is responsible for:

- Loop state and transitions.
- Scheduling and trigger coalescing.
- Bounded retries and no-progress detection.
- Verification evidence and completion evaluation.
- Cancellation, interruption, and resume.
- Writer isolation needed by unattended loops.

Provider authentication, deployment authorization, secret management, and vendor integrations remain the responsibility of Pi or other installed packages.

## Storage and cleanup

Attended goal state is stored in user-local Pi Loops storage, not added to the target repository.

Current retention behavior:

- Keep at most 50 eligible terminal runs per project.
- Remove the least recently used run when that limit is exceeded.
- Remove its Pi Loops runtime record, ID index, evidence, logs, and managed child-session data completely.
- Never automatically remove active, interrupted, queued, or unresolved-worktree runs.
- Never treat a project code branch as disposable runtime storage.

Pi session history is append-only. `/loops delete` cannot erase the user's command, agent messages, or concise state entries already written to the parent Pi transcript. New state entries intentionally omit goal text and evidence. Project files and Git history are also outside runtime-record deletion.

## Upgrade and uninstall behavior

Persisted run, schedule, trigger, notice, and configuration records currently use schema version 1. Release candidates must continue reading frozen version-one fixtures without rewriting them. Future migrations must be explicit, sequential, validated, atomic, and performed only while the relevant mutation lease is held. Unknown newer record versions fail closed and are never downgraded or discarded.

Upgrading or reinstalling the npm package preserves user-local Pi Loops runtime state. Uninstalling removes package files but intentionally leaves user runtime state untouched; Pi Loops has no uninstall lifecycle script that could delete user data. Use confirmed `/loops delete` operations or the documented Pi Loops data boundary before uninstalling if that state should be removed. Git branches, project files, and parent Pi transcripts remain outside package-uninstall cleanup.

## Configuration

Configuration will be optional. Planned precedence is:

```text
Invocation overrides
→ project configuration
→ user configuration
→ built-in defaults
```

No project configuration file will be created automatically.

## Development roadmap

### Phase 0 — Foundation and technical spikes

- Package and test harness.
- RPC worker lifecycle.
- Storage and writer leases.
- Evaluator integration.
- Packed-package clean-install testing.

### Phase 1 — Goal loops (implemented)

- Natural-language and `/loops goal` entry points.
- Status, stop, interruption recovery, and resume.
- Completion contracts and bounded evidence.
- Fresh evaluation, budgets, stall detection, persistence, leases, and retention.

### Phase 2 — Scheduling (implemented)

- One-off and recurring schedules.
- Coalescing and project binding.
- Worktree-isolated child execution.
- Review branches and restart recovery.

### Phase 3 — Proactive triggers (implemented)

- Confirmed, project-contained filesystem triggers.
- Namespaced Pi event-bus integration.
- Model-facing firing of confirmed trigger definitions.
- Debounce, coalescing, restart, and trigger-storm protection.

### Phase 4 — Production hardening (complete)

- State migrations and compatibility hardening.
- Comprehensive security audit.
- Supply-chain and package-content review.
- Release automation and clean-install release candidates.

### Phase 5 — Linux and Windows qualification (complete)

- Native Ubuntu 24.04 and Windows Server 2025 matrices cover the minimum and current supported Node lines.
- Packed runtime, process-tree cleanup, Git isolation, locking, recovery, migration, and uninstall checks run on both platforms.
- Real Pi 0.80.6 RPC lifecycle and proactive writer gates exercise native child cleanup and review branches.
- Forced-parent-death cleanup is repeated 10 times per native lifecycle run.

Physical devices are not required; native CI runners provide the operating-system evidence. The remaining work is the final clean-install and manual publication gate.

Code will be reviewed and refactored between every phase rather than postponing cleanup until the end.

## Security

Pi packages execute with the user's system permissions. Review package source before installation.

The implemented foundation includes strict JSONL RPC parsing, bounded evaluator and state payloads, atomic state writes, ownership-token leases, and child recursion/deadline guards. Phase 4 adds automated production-dependency auditing, SPDX license review, CycloneDX SBOM validation, high-confidence tracked-secret scanning, static analysis, and non-publishing release-candidate artifacts. Scheduled and proactive child launch is enabled on the natively qualified macOS, Linux, and Windows/Pi 0.80.6 combinations; unknown platforms remain fail-closed.

Pi Loops does not store API keys or environment snapshots, approve permissions automatically, or merge review branches. A comprehensive vulnerability and supply-chain assessment remains required before release.

Report security issues through the private process documented in [`SECURITY.md`](SECURITY.md).

## Project status

The product contract and architecture are approved. Attended goals, scheduling, proactive triggers, production hardening, and native Linux/Windows qualification are complete for Pi 0.80.6. The final publication gate remains. No public npm release should be assumed from this README.

The internal design brief is maintained temporarily under `.project-design/` during development. That directory will be removed before the first public release, after preserving relevant user-facing information here.

## License

Pi Loops is licensed under the [MIT License](LICENSE).
