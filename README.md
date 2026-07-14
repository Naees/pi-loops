# Pi Loops

[![npm version](https://img.shields.io/npm/v/@naees/pi-loops)](https://www.npmjs.com/package/@naees/pi-loops)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Pi Loops keeps [Pi](https://pi.dev) working on a coding goal until the result is verified or a finite limit is reached.

Pi Loops is founded on these simple principles, it should:
> 1. work out of the box with no setup required after installation.
> 2. does not work with cloud implementations, for now.
> 3. it must have strong stopping conditions to prevent overruns.

It can run goals interactively, on a schedule, or in response to a confirmed filesystem or extension event. Every loop has explicit time and cycle limits, checks its work, and ends with a clear outcome. This will help users to facilitate loop engineering workflows, to find out more about loop engineering here is a [quick start](https://claude.com/blog/getting-started-with-loops) guide.

> **Compatibility:** version 0.1.0 is qualified on macOS, Linux, and Windows with Pi 0.80.6., although, we are looking for collaborators to verify functionality different operating systems.

## What Pi Loops does
Pi Loops gives Pi a bounded cycle for:
1. clarifying a goal and its constraints;
2. working toward the goal;
3. collecting deterministic evidence, such as test results;
4. evaluating whether the goal is complete; and
5. feeding failures back into another attempt when limits allow.

In short: it helps Pi persist on verifiable tasks without turning into an unbounded background agent.

## What Pi Loops is not
1. Pi Loops is not a daemon or hosted automation service. It runs only while Pi is running.
2. It does not approve permissions, store API keys, merge unattended work automatically, or replace Pi's authentication and permission behavior.

## Install
Pi Loops requires an existing, working Pi installation with an authenticated model provider and a trusted project.

```sh
pi install npm:@naees/pi-loops
```

No configuration is required for normal use.

For scheduled or proactive code-writing runs, Git is required. Windows additionally requires PowerShell 7 for process lifecycle containment.

## Quick start
Ask naturally:
```text
Keep fixing the authentication implementation until the auth tests pass.
Do not modify the tests.
```
Or create an explicit goal:
```text
/loops goal Fix authentication until `npm test -- auth` passes. Do not modify existing auth tests.
```

Pi Loops works in the current attended session, runs the required checks, evaluates the result, and retries within a finite budget. Use `/loops status` to inspect the run or `/loops stop` to end it.

## Loop modes
| Mode | Trigger | Workspace | Best for |
| --- | --- | --- | --- |
| Attended goal | A natural-language request or `/loops goal` | Current checkout | Interactive fixes and debugging |
| Scheduled | A time or recurring interval | Isolated Git worktree | Maintenance and recurring checks |
| Proactive | A confirmed path or Pi extension event | Isolated Git worktree | Event-driven tasks |

Scheduled and proactive writers leave successful work on a review branch such as `pi-loops/run-a4f2`. They never merge automatically or modify the active branch during finalization.

## How completion works
```text
Goal → Work → Verify → Evaluate
          ↑          │
          └── Retry ─┘
```

Pi Loops combines:

- **Deterministic evidence**, such as a verifier command exiting successfully.
- **Fresh model evaluation** for completion criteria that require judgment.

Required deterministic checks take precedence: the evaluator cannot declare success while a required check is failing or missing.

The default attended-goal budget allows up to three hours of active execution and 15 outer work cycles. A run also stops after three equivalent no-progress cycles. Runs end explicitly as completed, failed, cancelled, interrupted, stalled, or budget exhausted.

## Commands
| Command | Purpose |
| --- | --- |
| `/loops goal <goal>` | Start an attended bounded goal |
| `/loops schedule <time> -- <goal>` | Create a one-off or recurring schedule |
| `/loops watch <path\|event> -- <goal>` | Create a confirmed proactive trigger |
| `/loops status` | Show runs, schedules, and triggers |
| `/loops stop [id]` | Stop a run or pause a schedule or trigger |
| `/loops resume [id] [guidance]` | Resume eligible work |
| `/loops clean` | Enforce terminal-record retention limits |
| `/loops delete <id>` | Confirm and remove one stored record |

The model-facing `pi_loops` tool exposes corresponding `goal`, `schedule`, `trigger`, `status`, `stop`, and `resume` actions.

## Examples

### One example for each loop type

**Attended goal** — work interactively until a check passes:

```text
/loops goal Fix the authentication bug until `npm test -- auth` passes. Do not modify the tests.
```

**Scheduled loop** — repeat maintenance while Pi remains open:

```text
/loops schedule every 6 hours -- Run the test suite and fix regressions without changing tests.
```

**Proactive loop** — respond to changes in a confirmed project path:

```text
/loops watch src/auth -- Run the authentication tests after changes and fix any regressions without changing tests.
```

Pi asks for confirmation before creating a schedule or proactive trigger. The watched path must already exist inside the current project.

### Two brief workflows

**1. Fix and monitor a failing test**

Start the loop:

```text
/loops goal Fix checkout until `npm test -- checkout` passes. Do not modify the tests.
```

Then inspect it:

```text
/loops status
```

**2. Resume interrupted work with guidance**

Find the run ID:

```text
/loops status
```

Then resume it:

```text
/loops resume run_a4f2c1d3 Focus on the token refresh failure first.
```

## Change limits for one run

Pi Loops supports two per-run budget overrides:

- `maxCycles`
- `maxActiveMinutes`

These overrides are available through the model-facing `pi_loops` tool. They are not `/loops` command flags.

### Attended goal

Paste the following into Pi and replace the goal placeholder:

```text
Call the pi_loops tool now with:

action: goal
goal: <describe the goal>
maxCycles: 30
maxActiveMinutes: 240

Use these exact limits for this run.
```

For example:

```text
Call the pi_loops tool now with:

action: goal
goal: Fix authentication until npm test -- auth passes. Do not modify the tests.
maxCycles: 30
maxActiveMinutes: 240

Use these exact limits for this run.
```

### Scheduled goal

Custom limits on a schedule apply to every occurrence:

```text
Call the pi_loops tool now with:

action: schedule
scheduleExpression: every 30 minutes
goal: <describe the goal>
maxCycles: 20
maxActiveMinutes: 180

Use these exact limits for every occurrence of this schedule.
```

Pi will display a confirmation screen. Check the cycle and active-minute limits before approving the schedule.

### Resume an attended goal with new limits

An attended run can be resumed with a new finite budget epoch:

```text
Call the pi_loops tool now with:

action: resume
runId: <run_id>
maxCycles: 25
maxActiveMinutes: 300

Resume this attended run with a new finite budget epoch using these limits.
```

### Limitations

- Values must be positive whole numbers.
- Overrides apply only to the new run, schedule, or attended resume.
- Overrides do not change package-wide defaults.
- `/loops goal --max-cycles ...` is not supported; Pi Loops would treat the flags as goal text.
- Trigger definitions and unattended resumes cannot currently receive custom limits through the public interface.
- `stallThreshold` is not currently exposed through `pi_loops`.
- Do not edit installed package files directly; upgrades may overwrite those changes.

## Safety and isolation
Pi Loops is designed to fail closed:

- Every run has finite cycle and time limits.
- Only one writer may operate in a repository at a time.
- Unattended writers require a clean Git repository and an isolated worktree.
- Cancelling Pi or closing the parent process also stops managed child work.
- Unknown platforms and unqualified Pi versions cannot run unattended writers.
- Confirmed event triggers cannot supply new goals, credentials, paths, or budget overrides.

See [Operations](docs/operations.md) for recovery, retention, worktrees, upgrades, uninstall behavior, and detailed limits.

## Optional parallel workers
[pi-subagents](https://github.com/nicobailon/pi-subagents) is optional but recommended for parallel workers and independent review:

Pi Loops works without it and does not import its private implementation files.

## Documentation
- [Operations, recovery, data, review branches, upgrades, and troubleshooting](docs/operations.md)
- [Extension event integration contract](docs/integrations.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)
- [Security policy and private reporting](SECURITY.md)

## Project status
Version 0.1.0 includes attended goals, scheduling, proactive triggers, production hardening, and native macOS, Linux, and Windows qualification for Pi 0.80.6.

Unknown platforms and unqualified Pi versions remain fail-closed for unattended execution.

## Security
Pi packages execute with the user's system permissions. Review package source before installation.

Pi Loops does not store API keys or environment snapshots, approve permissions automatically, or merge review branches. Report vulnerabilities through the private process in [SECURITY.md](SECURITY.md).

## License
Pi Loops is licensed under the [MIT License](LICENSE).
