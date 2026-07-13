# Pi Loops

Pi Loops is a [Pi](https://pi.dev) package for bounded attended goals, schedules, and proactive triggers. It works, verifies, evaluates, and retries until the goal succeeds or reaches a finite limit.

> Pi Loops runs only while Pi is running. It does not install a daemon or hosted service.

## Install

```text
pi install npm:@naees/pi-loops
```

No Pi Loops configuration is required for normal use.

### Requirements

- Node.js 22.19.0 or newer.
- An authenticated Pi model/provider.
- Git for scheduled or proactive writing.
- PowerShell 7 on Windows for unattended process containment.

Unattended execution is qualified with Pi 0.80.6 on macOS, Ubuntu 24.04, and Windows Server 2025. Unknown platforms and unqualified Pi versions fail closed for unattended work.

## Use

Natural language:

```text
Keep fixing authentication until the auth tests pass. Do not modify the tests.
```

Commands:

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

Schedule expressions are limited to:

```text
in <duration>
at HH:MM
every <duration>
```

Recurring schedules have a five-minute minimum. Schedule and trigger creation require interactive confirmation.

The `pi_loops` tool exposes `goal`, `schedule`, `trigger`, `status`, `stop`, and `resume`. Its `trigger` action can fire only an existing confirmed trigger definition; it cannot replace the stored goal, checks, budget, or project binding.

## Execution model

### Attended goals

Attended goals use the current Pi session and checkout. Required verifier commands are authoritative; a model evaluation cannot declare completion while required evidence is missing or failing.

The default budget is:

- 3 hours of active execution.
- 15 work cycles.
- Stall after 3 equivalent failures.

Budget overrides must be positive safe integers and are never silently increased or clamped.

### Scheduled and proactive work

Unattended writers require a clean Git checkout. Each run uses an isolated worktree and a review branch named:

```text
pi-loops/<run-id>
```

Pi Loops never merges that branch automatically. One active writer is allowed per canonical repository across Pi profiles.

Missed schedule occurrences are discarded. Overlap retains at most one coalesced pending occurrence. Filesystem triggers are project-contained and debounced; each project may store at most 50 trigger definitions.

Other Pi extensions may fire an existing confirmed event trigger with the strict payload documented in [`docs/integrations.md`](docs/integrations.md).

## Safety and lifecycle

Closing Pi cancels local occurrences, stops child workers and descendants, persists recoverable state, and releases watchers and leases. Silence, missing UI, malformed input, timeout, abort, or an unsupported environment never implies approval.

Pi Loops does not:

- Store provider credentials or environment snapshots.
- Approve Pi permissions automatically.
- Listen on a network port.
- Continue work after Pi exits.
- Merge review branches.
- Delete project files, Git history, parent Pi transcripts, or unmanaged paths during cleanup.

Runtime state is stored under:

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-loops
```

Upgrades, reinstallations, and npm uninstall preserve this state. Use confirmed `/loops delete` operations when stored Pi Loops records should be removed. Review branches always require normal Git review and cleanup.

## References

- [Operations, recovery, data, review branches, and troubleshooting](docs/operations.md)
- [Extension event integration contract](docs/integrations.md)
- [Security policy and private reporting](SECURITY.md)
- [Release history](CHANGELOG.md)

[`pi-subagents`](https://github.com/nicobailon/pi-subagents) is optional and can provide parallel workers or independent review. Pi Loops does not require or import its private APIs.

## License

[MIT](LICENSE)
