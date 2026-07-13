# Phase 4 bounds and budget calibration

**Date:** 2026-07-13
**Status:** Calibrated for the validated macOS/Pi 0.80.6 release-candidate scope
**Disposition:** Keep current defaults and hard safety ceilings; no runtime limit was widened.

## Method

The calibration inventory covered every user budget, count cap, byte ceiling, retry interval, debounce window, retention bound, lease timeout, subprocess timeout, and shutdown deadline in production source. Evidence came from exact boundary tests, complete-suite and coverage runs, packed release-candidate tests, contention stress runs, and authenticated Pi lifecycle runs. Coverage is supporting evidence, not a substitute for boundary behavior.

The current release-candidate evidence is 59 test files / 348 tests, 93.08% line coverage and 83.74% branch coverage, packed upgrade/uninstall/reinstall success, authenticated attended and proactive E2E success, and forced-parent-death cleanup 10/10.

## User workflow limits

| Boundary | Current value | Safety purpose | Calibration disposition |
|---|---:|---|---|
| Default active time per epoch | 3 active hours | Prevent indefinite work while allowing medium/large local tasks | Retain. Active time, not wall-clock waiting, is charged. Users can stop at any time. |
| Default outer cycles per epoch | 15 | Bound model/tool iterations independently of time | Retain. Real E2E completes in one cycle; 15 leaves recovery room without making repeated failure unbounded. |
| Equivalent-failure stall threshold | 3 | Stop repeated no-progress outcomes before the cycle limit | Retain. Three permits one retry and one confirmation while still stopping well before 15 cycles. |
| Recurring schedule minimum | 5 minutes | Prevent high-frequency unattended writer loops | Retain. Missed runs are discarded and overlap has only one pending occurrence. |
| Eligible terminal retention | 50 per project | Bound routine state accumulation | Retain. Active, interrupted, recoverable, queued, and unresolved-worktree records remain ineligible. |
| Trigger definitions | 50 per project | Bound watchers, persisted definitions, and startup work | Retain. Store and controller both fail closed above the limit. |
| Filesystem debounce | 100 ms–60 seconds | Reject pathological values while supporting editor bursts and slower build trees | Retain. Default public creation behavior remains within this range. |
| Process-local event debounce | 250 ms | Collapse synchronous event bursts | Retain. Exact-boundary and pending-delivery tests pass. |
| Concurrent event-ingress keys | 64 | Bound process-local trigger work | Retain. Admission fails closed at capacity. |
| Remembered event IDs | 128 per trigger | Bound deduplication memory | Retain. The 128/129 eviction boundary is tested. |
| Pending trigger deliveries | One per definition | Prevent trigger storms from creating an unbounded queue | Retain. Current plus one pending is sufficient for coalescing semantics. |

Budget overrides remain positive safe integers rather than silently clamped. This preserves persisted version-one compatibility and avoids inventing an undocumented maximum during hardening. The package still permits only one repository writer, exposes stop/cancel, stops when Pi exits, and requires a new finite epoch after exhaustion or stall. A provider monetary cap is not claimed.

## Contract, evaluation, and UI limits

| Boundary | Current value | Notes |
|---|---:|---|
| Goal text | 16 KiB for new completion contracts | Run storage accepts the established wider legacy shape where required for compatibility. |
| Constraints | 50 × 4 KiB | Deduplicated in completion contracts; evaluator applies an independent aggregate ceiling. |
| Verifier commands | 20 × 4 KiB | Exact commands are authoritative deterministic evidence. |
| Captured bash results per cycle | 200 | Only exact required verifier evidence is persisted into the run record. |
| Captured verifier summary | 8 KiB | UTF-8-safe truncation includes its marker within the byte ceiling. |
| Evaluator field text | Up to 32 KiB by field class | Smaller limits apply to criteria, summaries, and feedback. |
| Aggregate evaluator request | 128 KiB | Checked before provider invocation. Oversized combinations fail closed rather than consuming unbounded provider input. |
| Evaluator response | 64 KiB | Strict JSON decision parsing and semantic validation follow the byte check. |
| Worker UI text/option | 16 KiB | Applies to titles, messages, placeholders, prefill, and each option. |
| Worker UI options | 100 | Empty or oversized option lists fail closed before parent UI invocation. |

The aggregate evaluator ceiling intentionally overrides the theoretical sum of every individually maximal field. This protects the provider boundary from adversarial combinations. Normal contracts retain all required evidence; pathological maximal combinations receive an explicit bounded-payload failure and can be reduced rather than being silently dropped.

## Storage and file limits

| Boundary | Current value | Notes |
|---|---:|---|
| Run record | 2 MiB | Includes transition history, latest evidence/evaluation, worker identity, and bounded budget history. |
| Schedule record | 1 MiB | Significantly above the strict per-field maximum while still bounding reads and writes. |
| Trigger record | 1 MiB | Same rationale as schedules. |
| Notice record | 16 KiB | Current record contains only schema version and recommendation dismissal. |
| Pi/package manifest read | 256 KiB | Sufficient for normal manifests; oversized input fails closed. |
| Git identity/output | 64 KiB / 1 MiB | Identity and command output are separately bounded. |
| Tracked file secret scan | 4 MiB per text file | Oversized tracked files require explicit manual review; symlinks are not followed. |
| Security command output | 16 MiB | Bounds audit/SBOM subprocess capture. |

All JSON record reads use a single handle and read at most `maxBytes + 1`, so growth after metadata inspection cannot bypass the ceiling. Writes use same-directory atomic replacement. Frozen version-one packed fixtures fit far below their record ceilings and remain byte-for-byte unchanged across install, upgrade, uninstall, and reinstall.

## RPC and process limits

| Boundary | Current value | Safety purpose |
|---|---:|---|
| JSONL line | 1 MiB | Bound each protocol envelope before parsing. |
| Retained RPC event bytes | 8 MiB | Bound one worker client's retained transcript window. |
| Retained RPC events | 10,000 | Independent count ceiling for tiny-event floods. |
| Retained stderr | 64 KiB | Preserve diagnostics without unbounded child output. |
| RPC request timeout | 30 seconds | Bound command acknowledgement and state queries. |
| Default event wait | 60 seconds | Bound missing settlement/events. Absolute run deadline remains independent. |
| Git command timeout | 30 seconds | Prevent hung Git subprocesses. |
| Pi version probe | 5 seconds / 16 KiB | Bound executable qualification. |
| Graceful RPC abort/exit stages | 2 seconds each | Escalate from abort to termination without indefinite shutdown. |
| Child watchdog graceful stage | 1 second | Preserve a short cleanup opportunity before forced termination. |
| Lease stale period | 30 seconds for controllers/claims | Heartbeat refreshes at no more than half the stale interval. |
| Writer retry interval | 1 second | Responsive cancellation without hot polling. |
| Schedule claim recheck | 5 seconds | Reconcile cross-process ownership well inside the 30-second stale window. |
| Long timer chunk | 2,147,000,000 ms | Avoid platform timer overflow while preserving absolute deadlines. |

The 8 MiB/10,000-event pair bounds both large and tiny event floods. Production lifecycle evidence demonstrates normal Pi cycles remain well below these limits. Forced parent death, model-tool cancellation, streaming abort, UI relay, same-session resume, SIGINT, and SIGTERM all pass within their bounded cleanup stages.

## Security conclusions

- No production boundary relies on an unbounded JSON read, subprocess output capture, retained event collection, trigger queue, retry queue, or eligible terminal-record count. Protected interrupted/recoverable/unresolved-worktree records are intentionally not auto-deleted; explicit confirmed cleanup is required to avoid trading bounded storage for data loss.
- User budget overrides are finite and explicit; defaults remain the calibrated product contract.
- Required deterministic evidence is never dropped to fit evaluator input.
- Unknown persisted schema versions fail closed without rewrite.
- Linux and Windows values are not calibrated by this report; native Phase 5 evidence may justify platform-specific implementation changes but must not weaken these ceilings.

No critical/high bound defect remains in the validated macOS scope. This calibration does not complete the broader Phase 4 threat model or security review.
