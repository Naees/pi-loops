# Pi Loops

> **Status: attended Phase 1 goal loops are implemented in source; no public npm release exists yet.**

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

No Pi Loops configuration will be required for normal use.

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

Goal loops currently run in the attended Pi session and current checkout. Scheduling is planned for Phase 2 and is not enabled yet.

## Loop modes

Pi Loops is delivered in phases:

1. **Turn-based verification and attended goal loops — implemented:** bounded cycles, deterministic evidence, fresh evaluation, status, stop, interruption, and resume.
2. **Scheduled loops — planned:** trigger goals at a time or interval while Pi is running.
3. **Proactive loops — planned:** trigger goals from filesystem or other Pi-extension events.

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

## Implemented command surface

```text
/loops goal <goal>
/loops status
/loops stop [run-id]
/loops resume [run-id] [guidance]
/loops clean
/loops delete <run-id>
```

The model-facing `pi_loops` tool exposes equivalent `goal`, `status`, `stop`, and `resume` actions, including optional explicit verifier commands, constraints, and finite budget overrides.

Scheduling and watch commands remain planned for later phases. `/loops clean` enforces bounded terminal-record retention; `/loops delete` requires confirmation and removes one stored run record.

Each goal execution receives a run ID such as `run_a4f2`.

If only one run is resumable, `/loops resume` will not require its ID. If several qualify, Pi Loops will present a selector.

## Scheduled-writing isolation

Attended goals may work in the current checkout.

Scheduled and proactive writers will use an isolated Git worktree and a namespaced branch such as:

```text
pi-loops/run-a4f2
```

Successful unattended work will be left on that branch for review. Pi Loops will never merge it automatically or modify the user's active branch during finalization.

Unattended writing will pause when:

- The repository is not a Git repository.
- The working tree is dirty.
- A safe isolated worktree cannot be created.

Attended goals and read-only schedules can still operate in those cases.

## Process boundary

For isolated unattended work, Pi Loops will start a narrowly scoped child Pi process in documented RPC mode. The child will:

- Use the existing Pi installation and model configuration.
- Run in the isolated worktree.
- Receive tasks through JSON stdin rather than shell interpolation.
- Have finite cycle and time limits.
- Stop when cancelled or when the parent Pi exits.
- Be prevented from recursively launching another Pi Loops child.

A mandatory implementation spike must prove cancellation, crash cleanup, resume, and no-orphan behavior before scheduled writing is considered complete.

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

### Phase 1 — Goal loops (implemented, undergoing hardening)

- Natural-language and `/loops goal` entry points.
- Status, stop, interruption recovery, and resume.
- Completion contracts and bounded evidence.
- Fresh evaluation, budgets, stall detection, persistence, leases, and retention.

### Phase 2 — Scheduling

- One-off and recurring schedules.
- Coalescing and project binding.
- Worktree-isolated child execution.
- Review branches and restart recovery.

### Phase 3 — Proactive triggers

- Filesystem triggers.
- Namespaced Pi event-bus integration.
- Model-facing triggers.
- Debounce and trigger-storm protection.

### Phase 4 — Production hardening

- Compatibility matrix.
- State migrations.
- Comprehensive security audit.
- Supply-chain and package-content review.
- Clean-install release validation.

Code will be reviewed and refactored between every phase rather than postponing cleanup until the end.

## Security

Pi packages execute with the user's system permissions. Review package source before installation.

The implemented foundation includes strict JSONL RPC parsing, bounded evaluator and state payloads, atomic state writes, ownership-token leases, and child recursion/deadline guards. Scheduled child launch remains blocked until lifecycle validation proves no shell interpolation, bounded process output, and reliable descendant cleanup.

Pi Loops does not store API keys or environment snapshots, approve permissions automatically, or merge review branches. A comprehensive vulnerability and supply-chain assessment remains required before release.

Report security issues through the private process documented in [`SECURITY.md`](SECURITY.md).

## Project status

The product contract and architecture are approved. Attended Phase 1 goal loops are implemented and under validation. Scheduling, proactive triggers, and final production hardening remain incomplete; no public npm release should be assumed from this README.

The internal design brief is maintained temporarily under `.project-design/` during development. That directory will be removed before the first public release, after preserving relevant user-facing information here.

## License

Pi Loops is licensed under the [MIT License](LICENSE).
