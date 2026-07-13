# Phase 5 cross-platform readiness

**Date:** 2026-07-13  
**Decision:** Complete. Enable unattended scheduled and proactive writers on the independently qualified `darwin`, `linux`, and `win32` platforms for Pi `0.80.6`. Unknown platforms remain fail-closed.

## Final native evidence

The production gate was enabled before the final packed qualification run.

- Phase 5 qualification: GitHub Actions run [`29265230974`](https://github.com/Naees/pi-loops/actions/runs/29265230974) — passed all six jobs.
- General CI: run [`29265229365`](https://github.com/Naees/pi-loops/actions/runs/29265229365) — passed.
- Security and CodeQL: run [`29265232870`](https://github.com/Naees/pi-loops/actions/runs/29265232870) — passed.
- Qualified commit: `7481880` (`Serialize Windows coverage qualification`).

### Linux

- Runner: Ubuntu 24.04 x64, image `20260705.232.1`.
- Node: `22.19.0` and current supported Node 24.
- Pi: `0.80.6`.
- Git: `2.54.0`.
- Real Pi RPC lifecycle, proactive runtime, isolated Git worktree, UI relay, same-session resume, streaming/tool abort, clean shutdown, and forced-parent-death cleanup passed.
- Forced-parent-death cleanup passed `10/10` in the final native lifecycle job.

### Windows

- Runner: Microsoft Windows Server 2025 x64, image `windows-2025-vs2026` version `20260628.158.1`.
- Node: `22.19.0` and current supported Node 24.
- Pi: `0.80.6`.
- Git for Windows: `2.54.0.windows.1`.
- PowerShell 7 Job Object smoke test reported `PI_LOOPS_SENTINEL_READY` and proved kill-on-close containment.
- Real Pi RPC lifecycle, proactive runtime, isolated Git worktree, UI relay, same-session resume, streaming/tool abort, normal shutdown, and forced-parent-death cleanup passed.
- Forced-parent-death cleanup passed `10/10` in the final native lifecycle job.

## Matrix coverage

The final run passed:

- Source and script typechecks on Linux and Windows.
- The complete unit/integration suite on Node `22.19.0` and Node 24.
- Coverage on both native operating systems; Windows coverage was serialized to prevent instrumentation-driven I/O contention from weakening test synchronization.
- Production advisory, license, tracked-secret, immutable-action, and package-content checks.
- Packed install with an isolated Pi home.
- Frozen version-one state upgrade, uninstall, and reinstall compatibility.
- Packed scheduled and proactive Git writer isolation and review-branch output.
- Native paths containing spaces.
- Windows drive-letter, mixed-case, junction, linked-worktree, atomic replacement, lease, and cross-process lock behavior.
- Linux signals/process groups and Windows kill-on-close Job Object process-tree cleanup.
- Production-platform constants from the packed candidate after enablement.

No safety test was skipped. The native runtime remained bounded to the Pi process lifecycle, prompts remained off argv, and no shell interpolation or automatic merge was introduced.

## Windows lifecycle decision

Direct `taskkill /T` escalation was insufficient after the RPC parent disappeared because Pi could observe closed stdin and exit before `taskkill` captured the intact tree. The qualified implementation assigns the Pi worker to a nested Windows Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. The Job Object owner is a bounded PowerShell 7 sentinel. Closing the last job handle terminates associated processes, including inherited descendants.

This follows the documented Windows behavior:

- [Microsoft: Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- [Microsoft: Nested Jobs](https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs)
- [Microsoft: AssignProcessToJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject)
- [Node.js: child process spawning and detached semantics](https://nodejs.org/api/child_process.html)

Windows Server 2025 supports nested jobs, and the qualified GitHub image provides PowerShell 7. Public operations documentation therefore records PowerShell 7 as a Windows prerequisite.

## Local regression evidence

On macOS, the enabled-platform candidate passed:

- 63 test files and 394 tests.
- Serialized coverage: 88.38% statements, 84.27% branches, 88.59% functions, and 92.64% lines.
- Packed install, packed state compatibility, packed scheduled/proactive writer, native Pi lifecycle, and proactive qualification.
- Repeated forced-parent-death cleanup `10/10`.
- Security checks with zero audited vulnerabilities and four production dependencies.
- Package inspection: 72 files and 357,519 unpacked bytes.

## Remaining release work

Phase 5 no longer blocks Linux or Windows unattended execution. Publication remains blocked until the separate release procedure:

1. Removes `.project-design/` and `.pi-subagents/` from the release checkout.
2. Runs the final hosted release-candidate and `release:check` gates.
3. Inspects the tarball, SBOM, inventory, and checksums.
4. Restores authenticated npm publisher access and performs the manual publish.

No package has been published.
