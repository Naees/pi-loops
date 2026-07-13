# Phase 4 security and production-readiness review

**Date:** 2026-07-13
**Status:** First comprehensive pass complete; hosted revalidation pending for the latest hardening changes
**Scope:** macOS/Pi 0.80.6 release candidate, package/update boundary, and platform-neutral state/event parsing
**Out of scope:** Native Linux and Windows runtime qualification, which remains Phase 5

## Release policy

A public release is blocked by any unresolved critical/high finding, an unproven no-orphan guarantee, an unintended package file, an unclean final tree, a mutable release workflow dependency, or a failing authenticated runtime gate. Automated checks supplement manual boundary review; they do not replace it.

## Assets and trust boundaries

Protected assets:

- User project files, active Git checkout, Git history, and review branches.
- Pi provider credentials, process environment, current model/session identity, and parent transcript.
- User intent expressed through confirmed schedules/triggers and explicit completion contracts.
- Pi Loops run, schedule, trigger, notice, lease, evidence, and managed child-session state.
- Process ownership: parent Pi, RPC child Pi, model-initiated tool descendants, and shutdown deadlines.
- Package integrity, lockfile integrity, CI credentials, SBOM/license evidence, and release artifacts.

Threat sources considered:

- Malicious or malformed project files, package manifests, Git output, filesystem paths, and symlinks.
- Hostile extension event payloads and trigger storms.
- Malformed, oversized, reordered, unsolicited, or stalled child RPC traffic.
- A compromised or confused child/model requesting parent UI or emitting misleading completion summaries.
- Concurrent Pi processes, stale owners, lock compromise, abrupt parent death, and external Git tools that ignore advisory locks.
- Corrupted or future-version user-local state.
- Dependency, npm-registry, GitHub Actions, or release-workflow compromise.
- A same-user local process that can modify Pi Loops files or process state.

## Boundary review

### Parent extension and public interface

Controls verified:

- Only `/loops` and `pi_loops` expose workflow actions; neither is a general shell or permission API.
- Schedule/trigger creation and runtime-data deletion require interactive UI confirmation and fail closed without UI.
- Explicit verifier commands take precedence over inferred commands; missing/failing deterministic evidence cannot be overridden by model evaluation.
- Event payloads accept only `{ schemaVersion: 1, triggerId, eventId? }`; goals, paths, budgets, commands, credentials, and unknown fields are rejected.
- Trigger event admission, deduplication, debounce, pending work, and error notifications are bounded.
- Parent transcript entries are concise and omit goal/evidence text. Append-only Pi transcripts are never edited directly.

### Child process and RPC

Controls verified:

- Child processes use argument-array spawning with `shell: false`; prompts cross stdin and do not appear in argv.
- The current Pi executable and package identity are canonicalized, version-probed, and validated without arbitrary PATH precedence.
- Child environment inherits the current Pi process environment so the same authenticated provider/runtime can operate, but repository-shaping Git variables are removed and Git prompts/optional locks are disabled. Pi Loops adds only its recursion marker, ownership token, and absolute deadline, and never logs or persists an environment snapshot.
- JSONL lines, retained events, event count, stderr, requests, waits, UI requests, and evaluator traffic are independently bounded.
- Response IDs/commands are correlated; malformed, duplicate, unknown, late, and unsolicited responses fail closed.
- Parent UI relay validates methods, IDs, text, options, levels, cancellation, and no-UI behavior before invoking UI.
- Graceful abort, stdin close, SIGTERM, SIGKILL, child watchdog, attached pipes, and absolute deadlines provide bounded cleanup stages.
- Production lifecycle evidence covers streaming abort, model-tool abort and descendants, UI relay, session resume, SIGINT, SIGTERM, and forced parent death 10/10.

### Filesystem and persisted state

Controls verified:

- Every production file read is now performed through a bounded handle or bounded protocol decoder. Concurrent file growth cannot bypass a `maxBytes + 1` ceiling.
- JSON records use strict key allowlists, canonical IDs, project binding, state coherence, size/count limits, and complete-record validation before use.
- Unknown newer run/schedule/trigger schema versions fail closed without mutation. Reviewed migrations advance one version at a time, validate output, and persist only under the relevant lease through atomic replacement.
- Atomic writes use same-directory exclusive temporary files and replacement. Concurrent readers and interrupted subprocess writers cannot expose partial primary JSON.
- Data directories/files are created with private modes where Pi Loops owns creation. Secret scanning does not follow tracked symlinks.
- Filesystem triggers require canonical project-contained targets, ignore Git metadata, reject null/unattributed names, and revalidate device/inode identity.
- Managed child-session deletion is constrained to the project/run-owned directory and does not follow symlinks or delete unmanaged metadata paths.
- Uninstall has no lifecycle script and intentionally preserves user runtime state; confirmed Pi Loops cleanup remains separate from package-file removal.

### Git and concurrency

Controls verified:

- Unattended writers require a canonical Git repository, clean active checkout, validated base ancestry, isolated managed worktree, and `pi-loops/<run-id>` review branch.
- Successful unattended work is committed for review and never automatically merged. The active checkout remains unchanged.
- User-global repository locks converge across Pi data roots through canonical common-Git-directory identity.
- Project writer, schedule occurrence/execution, and trigger claims use proper-lockfile ownership plus tokenized metadata, compromise signals, stale takeover, and bounded retry/recheck intervals.
- Only one Pi Loops writer is active per canonical repository; mixed scheduled/proactive orderings and child-process contention are tested.
- External Git tools do not honor the advisory Pi Loops lock; this is documented residual behavior, not represented as a mandatory repository lock.

### Evaluator and evidence

Controls verified:

- Deterministic verifier output is matched only to exact executed bash commands, uses latest-execution precedence, and is authoritative.
- Evidence, summaries, criteria, feedback, aggregate evaluator input, and evaluator response are byte bounded with UTF-8-safe truncation.
- Aggregate payload validation occurs before provider invocation. Cancellation wins before and after authentication resolution.
- Evaluator decisions use strict structured parsing and reject empty/contradictory completion states both at the provider and storage boundary.
- Pi Loops does not implement provider authentication, persist credentials/environment snapshots, or claim a monetary spending cap.

### Supply chain and release automation

Controls verified:

- Production dependencies are limited to `proper-lockfile` and its three transitive packages; CycloneDX lists four components with reviewed MIT/ISC licenses.
- npm audit reports zero vulnerabilities. No production dependency is currently outdated.
- Package `files` is an explicit allowlist; `.project-design/`, tests, coverage, subagent artifacts, and development scripts are rejected from tarballs.
- Tracked/untracked text files are scanned for high-confidence private-key, AWS, GitHub, and npm token patterns with bounded file reads and no secret-value logging.
- All external GitHub Actions are pinned to tested immutable 40-character commit SHAs. The security policy test rejects mutable action tags/branches.
- CI permissions are read-only by default and elevated only to `security-events: write` for CodeQL.
- Release-candidate automation creates checksummed review artifacts and cannot publish. Final publication additionally requires a clean tree, removal of internal design artifacts, and authenticated runtime gates.

## Findings and disposition

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| P4-SEC-001 | Medium | Notice, lease metadata, project package manifest, and current-Pi package manifest reads used `readFile()` after or without a size check, allowing same-user/project-controlled growth between metadata inspection and read. | Fixed. All four paths now use the single-handle bounded JSON reader; malformed/oversized tests pass. |
| P4-SEC-002 | Medium | GitHub Actions used mutable major-version references, allowing tag movement to change release automation without repository review. | Fixed. Every external action is pinned to the exact tested commit SHA, and `security:check` enforces immutable refs. |
| P4-SEC-003 | Medium | A malformed-response test interpolated serialized fixture data into `node -e` source, triggering CodeQL improper-sanitization analysis. | Fixed. Fixture envelopes cross through a dedicated data value; hosted CodeQL revalidation closed the alert. |
| P4-REL-001 | Medium availability | The npm 11-generated lockfile omitted optional metadata required by npm 10 clean installation. | Fixed. Lockfile regenerated with npm 10.9.3; clean npm 10/current installs and hosted Node 22.19/24 CI pass. |

No critical/high finding is open.

## Accepted residual risks and limitations

- Pi packages and child tools execute with the user's OS permissions; Pi Loops is not an OS sandbox.
- A malicious process running as the same user can tamper with local files/processes. Pi Loops detects malformed state and ownership changes but does not provide cryptographic local-state authenticity.
- The child Pi inherits provider-related environment values required by the current Pi installation and is therefore inside the same credential trust boundary as the parent. Pi Loops does not redact secrets from a child that must authenticate, but it does not place them in argv, logs, state records, or event payloads.
- External Git commands do not participate in Pi Loops' advisory writer lock.
- Parent Pi transcript entries and Git history are append-only/outside runtime deletion.
- User runtime state intentionally survives npm uninstall to avoid destructive lifecycle scripts.
- Provider-side cost accounting is outside Pi Loops; finite local budgets are not a guaranteed monetary cap.
- Linux and Windows unattended execution remain fail-closed until native Phase 5 matrices pass.

## Remaining Phase 4 security work

- Re-run hosted CodeQL/CI after the bounded-read and immutable-action changes and confirm zero open alerts.
- Review and either merge or close each Dependabot update independently; do not batch unreviewed major toolchain changes.
- Preserve final SBOM, tarball checksum, package inventory, workflow run URLs, runtime lifecycle output, and npm-scope access evidence with the release candidate.
- Perform one final source/diff review after public documentation and release-candidate changes settle.

This report is not a publication authorization and does not expand platform support.
