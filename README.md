# Pi Loops

> **Status: design approved; implementation is in progress.**  
> The npm package and commands described below are not available yet.

Pi Loops is a planned [Pi](https://pi.dev) package for bounded loop engineering: clarify a goal, work, verify the result, evaluate completion, feed back failures, and retry until the goal succeeds or a declared limit is reached.

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

## Planned usage

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

### Schedule work

```text
/loops schedule every 30m -- check CI and address failures
/loops schedule at 14:00 -- run release-readiness checks
/loops schedule in 2h -- recheck the deployment
```

Schedules will be active only while Pi is open in their project. Missed occurrences will not be replayed.

## Loop modes

Pi Loops is planned in phases:

1. **Turn-based verification** — strengthen Pi's normal agent loop with explicit evidence.
2. **Goal loops** — keep running bounded work cycles until completion is accepted.
3. **Scheduled loops** — trigger goals at a time or interval while Pi is running.
4. **Proactive loops** — trigger goals from filesystem or other Pi-extension events.

## Completion model

A goal loop combines two forms of verification:

1. **Deterministic evidence**, such as a test command exiting successfully.
2. **Fresh model evaluation** for criteria that require judgment.

Required deterministic checks take precedence. A model evaluator cannot declare success while a required check is failing or missing.

The initial default profile is planned as:

- 3 hours of active execution.
- 15 outer work cycles.
- Stop after 3 equivalent no-progress cycles.
- One active writer per repository.

Runs end explicitly as completed, failed, cancelled, interrupted, stalled, or budget exhausted. Interrupted and bounded-failure runs can be resumed with a new finite budget.

## Planned command surface

```text
/loops goal <goal>
/loops schedule <time-expression> -- <goal>
/loops status [run-id|schedule-id]
/loops stop [run-id]
/loops resume [run-id]
/loops watch ...
/loops clean [filters]
/loops delete <run-id>
```

Each execution receives a run ID such as `run_a4f2`. A persisted schedule receives a separate schedule ID.

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

[`pi-subagents`](https://github.com/nicobailon/pi-subagents) will be optional but highly recommended for parallel workers and independent review:

```text
pi install npm:pi-subagents
```

Pi Loops will not bundle, fork, or import private `pi-subagents` implementation files. The core package must work without it.

## Permissions and scope

Pi Loops will rely on Pi's existing permission behavior. It will not add a second permission framework or become a general policy package.

Pi Loops is responsible for:

- Loop state and transitions.
- Scheduling and trigger coalescing.
- Bounded retries and no-progress detection.
- Verification evidence and completion evaluation.
- Cancellation, interruption, and resume.
- Writer isolation needed by unattended loops.

Provider authentication, deployment authorization, secret management, and vendor integrations remain the responsibility of Pi or other installed packages.

## Storage and cleanup

Runtime state will be stored in user-local Pi Loops storage, not added to the target repository.

Planned retention behavior:

- Keep at most 50 eligible terminal runs per project.
- Remove the least recently used run when that limit is exceeded.
- Remove its ID, metadata, evidence, logs, and session data completely.
- Never automatically remove active, interrupted, queued, or unresolved-worktree runs.
- Never treat a project code branch as disposable runtime storage.

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

### Phase 1 — Goal loops

- Natural-language and `/loops goal` entry points.
- Status, stop, and resume.
- Completion contracts and evidence.
- Fresh evaluation, budgets, and stall detection.

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

The planned implementation includes:

- No shell interpolation for child launch.
- Strict JSONL RPC parsing.
- Bounded process output.
- Atomic state writes and ownership-token leases.
- Child recursion guards and independent deadlines.
- No stored API keys or environment snapshots.
- No automatic permission approval or branch merge.
- A final comprehensive vulnerability and supply-chain assessment.

Security issues should eventually be reported through the process documented in `SECURITY.md` once that policy is added.

## Project status

The product contract and architecture have been approved. Implementation has not yet been completed, and no public npm release should be assumed from this README.

The internal design brief is maintained temporarily under `.project-design/` during development. That directory will be removed before the first public release, after preserving relevant user-facing information here.

## License

Pi Loops is planned for release under the [MIT License](https://opensource.org/license/mit).
