# Pi Loops operations guide

Pi Loops runs only while the parent Pi process is open. It does not install a daemon, background service, webhook listener, or hosted component.

## Current support boundary

- Package status: prerelease development; no supported public npm release yet.
- Node.js: 22.19.0 or newer.
- Pi: unattended scheduled and proactive writers are qualified with Pi 0.80.6 on macOS, Linux, and Windows.
- Native qualification currently uses Ubuntu 24.04 and Windows Server 2025 with Node 22.19.0 and Node 24.
- Git is required for unattended writing. Attended goals use the current checkout.
- Windows requires PowerShell 7 for Job Object lifecycle containment.
- Unknown operating systems remain fail-closed.

A successful unit test run on another operating system is not evidence that unattended process cleanup or Git isolation is qualified there.

## Runtime lifecycle

Opening Pi in a project activates saved schedules and triggers for that project. Closing Pi:

1. Cancels local active occurrences.
2. Stops child RPC workers through bounded abort, input-close, terminate, and kill stages.
3. Persists interrupted work where recovery is possible.
4. Releases Pi Loops leases and filesystem watchers.

Missed scheduled occurrences are discarded. A recurring overlap retains at most one coalesced pending occurrence. No work runs after Pi exits.

## Data locations

The default runtime data root is:

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-loops
```

It contains project-keyed run, schedule, trigger, lease, and managed child-session data. Repository writer locks use the user-global namespace:

```text
~/.pi/agent/pi-loops/repository-writer-locks
```

That lock location intentionally remains common across distinct Pi profiles. External Git tools do not participate in the advisory Pi Loops lock.

Do not edit state or lease files while Pi Loops is active. Records are strict, versioned, bounded, and atomically replaced; malformed or unknown newer versions fail closed.

## Review branches

Unattended writers work in isolated managed worktrees and use branches named:

```text
pi-loops/<run-id>
```

Successful changes remain on the review branch and are never automatically merged. Typical review commands are:

```text
git log --oneline --decorate --all
git diff <base-branch>...pi-loops/<run-id>
git switch <base-branch>
git merge --no-ff pi-loops/<run-id>
```

Choose the correct base branch for the repository. Pi Loops does not decide or execute the final merge.

## Recovery

Use:

```text
/loops status
/loops resume [run-id] [guidance]
```

Exactly one resumable run can be resumed without an ID. Multiple candidates require selection. Interrupted and awaiting-user work preserves its finite epoch when safe. Stalled or exhausted work starts a new finite budget epoch and records the previous epoch in history.

Scheduled and proactive restart reuses the run ID, review branch, worktree, managed Pi session, and deadline when safe. A live persisted worker PID is never attached blindly.

## Stop, pause, clean, and delete

- `/loops stop <run-id>` cancels an active occurrence.
- `/loops stop <trigger-id>` pauses the trigger definition after cancelling its local active occurrence.
- `/loops resume <trigger-id>` enables a paused trigger definition.
- `/loops clean` removes only least-recently-used eligible terminal run records beyond the project limit.
- `/loops delete <id>` requires interactive confirmation and removes the selected Pi Loops runtime record.

Automatic retention never removes active, interrupted, recoverable, queued, or unresolved-worktree records. Pi Loops does not delete project branches, Git history, project files, unmanaged paths, symlink targets, or append-only parent Pi transcript entries.

## Upgrade, uninstall, and reinstall

Version-one state is the frozen prerelease compatibility baseline. Release candidates read it without rewriting. Future migrations must be reviewed, sequential, validated, atomic, and performed under the relevant mutation lease. Unknown newer versions are not downgraded.

An npm upgrade or reinstall preserves user runtime state. `npm uninstall` removes package files but intentionally leaves user runtime state in place; the package has no destructive uninstall lifecycle script. If state should be removed, use confirmed Pi Loops cleanup before uninstalling or manually remove only the documented Pi Loops data root after Pi has stopped and review branches have been handled.

Parent Pi transcripts, project files, and Git branches are outside npm uninstall behavior.

## Troubleshooting

### Writer lease is already held

Another Pi Loops controller currently owns the project or canonical repository writer lease. Stop the other run or Pi session. Do not delete a live lock manually. Stale takeover is automatic after bounded ownership checks.

### Repository is dirty

Unattended writing requires a clean active checkout before creating an isolated worktree. Commit, stash, or discard the changes yourself, then retry. Pi Loops will not alter unrelated active-checkout changes.

### Repository is not Git

Attended work remains available, but unattended writers require Git isolation. Initialize and commit the repository before retrying if unattended writing is required.

### Awaiting user

The child needed interaction that could not be safely relayed, Git finalization needs review, or completion evaluation requested guidance. Inspect `/loops status`, the review branch/worktree information, and resume with explicit guidance.

### Unsupported platform or Pi version

The unattended runtime gate is intentionally fail-closed outside the documented macOS, Linux, and Windows/Pi 0.80.6 combinations. Do not bypass it based on unit tests or code inspection. On Windows, verify that PowerShell 7 is installed at the standard Program Files location.

### Package removal did not remove state or branches

This is intentional. Uninstall is non-destructive. Runtime state uses explicit confirmed cleanup; review branches and Git history always require normal Git review/removal.
