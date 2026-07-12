# Phase 5 — Linux and Windows qualification and release

**Timing:** Final phase, after Phase 3 feature development and Phase 4 production hardening are complete.  
**Current support boundary:** Unattended scheduled writing remains enabled only on the validated macOS/Pi 0.80.6 combination.  
**Execution environments:** Native Linux and Windows CI runners or VMs; physical devices are not required.

## Objective

Finish the portability implementation, prove the production runtime on native Linux and Windows, and enable only the operating systems whose complete qualification matrices pass. Code inspection, mocks, containers running a foreign kernel, or successful unit tests alone are not platform evidence.

## Safety rule

The production platform gate stays fail-closed throughout development. Do not remove the macOS-only gate globally. Replace it with independently controlled platform qualification only after native evidence exists for that platform. A Linux pass must not enable Windows, and vice versa.

## Delivery slices

### 1. Portability inventory

Audit all platform-sensitive boundaries before changing the gate:

- Pi and Node executable resolution, including Windows launchers and paths with spaces.
- Process groups, signals, graceful abort, escalation, forced parent death, and descendant cleanup.
- JSONL stdin/stdout framing and newline behavior.
- Atomic writes, rename semantics, file permissions, symlinks, junctions, and path containment.
- User-home discovery and the user-global repository-lock namespace.
- `proper-lockfile` behavior, stale lease takeover, clock assumptions, and multi-process contention.
- Git common-directory discovery, linked worktrees, case-insensitive paths, hooks, and Git for Windows.
- Session-file canonicalization and restart identity.
- Shutdown ordering and timer cleanup.

### 2. Portable implementation

Implement Linux and Windows behavior without weakening existing controls:

- Preserve argument-array spawning and prohibit shell interpolation.
- Prefer launching Node with Pi's resolved JavaScript entry point rather than trusting PATH shims.
- Use platform-appropriate process-tree termination while retaining bounded graceful and forced stages.
- Keep prompt text and secrets out of argv and persisted environment data.
- Preserve strict canonical path and symlink/junction checks.
- Keep repository writer locks user-global and keyed by canonical Git identity.
- Keep platform enablement behind an explicit internal qualification gate until native tests pass.

### 3. Native Linux matrix

Run on a native Linux GitHub Actions runner or VM:

- Supported minimum Node and current supported Node.
- Minimum supported Pi and current validated Pi.
- Packed install with an isolated Pi home.
- Public `/loops` and `pi_loops` registration and schedule confirmation.
- Real Pi RPC prompt, streaming abort, tool abort, UI relay, same-session resume, and clean exit.
- Parent `SIGINT`, `SIGTERM`, forced death, child deadline, and descendant cleanup repeated at least 10 times.
- Real Git scheduled writer with active-tree isolation and review-branch output.
- Restart with the same run, branch, worktree, session, deadline, and correct budget epoch.
- Cross-process schedule claims and user-global writer locks across distinct Pi data roots.
- Dirty/non-Git, malformed metadata, symlink, path traversal, stale lock, and shutdown rollback cases.
- Packed upgrade/state-migration and uninstall cleanup.

### 4. Native Windows matrix

Run on a native Windows GitHub Actions runner or VM with Git for Windows:

- The same package, public UX, RPC, Git, restart, locking, migration, and cleanup cases as Linux.
- Paths containing spaces, mixed case, drive letters, UNC paths where supported, and junction containment.
- `.cmd`/`.exe` resolution without arbitrary PATH precedence or command-string interpolation.
- CTRL events where available, normal shutdown, forced worker termination, and descendant process-tree cleanup repeated at least 10 times.
- Atomic replacement and lease behavior under Windows file-sharing semantics.
- Case-insensitive canonical repository convergence across root, nested, symlink/junction, and linked-worktree paths.

### 5. Cross-platform regression and security review

After both native matrices:

- Re-run the macOS production lifecycle and packed writer gates.
- Run the complete unit/integration suite and coverage on all three operating systems.
- Repeat contention, stale takeover, forced-parent-death, and cleanup tests to expose flakes.
- Review platform-specific process execution, path handling, lock ownership, and deletion boundaries.
- Run dependency audit, secret scan, package inspection, license inventory, and SBOM generation.
- Confirm documentation names only platforms and Pi/Node versions actually proven.

### 6. Enablement and release

For each platform independently:

1. Record runner image, architecture, Node version, Pi version, Git version, and test commands.
2. Preserve machine-readable CI logs and a concise readiness report.
3. Resolve every critical/high finding and all orphan-process failures.
4. Change the production platform gate only for that proven platform.
5. Re-run its full matrix with the gate enabled from the packed release candidate.

After macOS, Linux, and Windows are all green, remove `.project-design/`, inspect the final tarball, perform clean installs, and run the publication gate.

## Exit criteria

- Native Linux and Windows qualification matrices pass without skipped safety tests.
- Forced-parent-death and descendant-cleanup tests pass repeatedly on each OS.
- Packed scheduled writers preserve the active tree and produce review branches on each OS.
- Restart identity and finite-budget behavior pass on each OS.
- Cross-process locks and claims pass on each OS.
- No unresolved critical/high security or portability findings remain.
- Public documentation accurately records supported versions and limitations.
- Final tarball, clean-install, migration, uninstall, and npm publication checks pass.
