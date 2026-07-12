# RPC Worker Spike — macOS Lifecycle Evidence

**Date:** 2026-07-12
**Platform:** macOS
**Pi:** 0.80.6
**Node:** 25.1.0

## Purpose

Validate the child-process lifecycle required before Phase 2 scheduling can use an unattended writer: strict RPC framing, controlled agent settlement, abort behavior, descendant cleanup, parent-signal handling, forced parent death, session/worktree resume, and extension UI relay.

This report records macOS evidence only. It does not claim Linux or Windows support.

## Commands

Baseline handshake and direct RPC bash cancellation:

```text
node scripts/spike-rpc-worker.ts
```

Independent child deadline:

```text
node scripts/spike-child-watchdog.mjs
```

Controlled agent and process lifecycle suite:

```text
PI_LOOPS_SPIKE_PI=/opt/homebrew/bin/pi node scripts/spike-rpc-lifecycle.ts
```

The lifecycle suite resolves and validates the explicitly selected executable as Pi 0.80.6 before testing. On this Homebrew installation, `/opt/homebrew/bin/pi` canonicalizes to the package's `dist/cli.js`.

## Harness

- `scripts/fixtures/rpc-lifecycle-extension.ts` registers a deterministic, local `streamSimple` provider through Pi's supported provider API and exercises the production current-Pi launch resolver inside the child runtime.
- The provider emits controlled text streaming and a real model-initiated built-in `bash` tool call without external network or provider variance.
- `scripts/fixtures/rpc-spike-client.ts` uses the production `RpcJsonlDecoder`, correlates requests, caps individual lines at 1 MiB, retained messages at 8 MiB, stderr at 64 KiB, and observes asynchronous RPC events and extension UI envelopes.
- `scripts/fixtures/rpc-lifecycle-parent.ts` owns a Pi RPC child for signal and forced-parent-death scenarios.
- Every run uses a temporary Git repository, isolated worktree, session directory, and PID evidence files.
- Task text is sent only through RPC stdin and is asserted absent from the Pi child process arguments.

## Observed results

### Baseline

- RPC process spawn and `get_state` handshake: passed.
- Child-mode extension suppression and recursion guard: passed.
- Direct 30-second RPC `bash` cancellation through `abort_bash`: passed.
- Closing stdin after cancellation: clean status-0 exit.
- Independent absolute deadline with stdin held open: passed.
- Shell interpolation for Pi launch: not used (`shell: false`).

### Executable resolution

- Production resolution derived the running Node executable plus the current Pi `dist/cli.js` from the child process itself: passed.
- The CLI's package manifest identity and version were matched against `@earendil-works/pi-coding-agent` and the executable probe: passed.
- The resolved command was independently probed with `--version` and returned Pi 0.80.6: passed.
- Resolution does not search or trust arbitrary PATH order: passed.
- Unit coverage also exercises a current standalone executable shape and fail-closed unknown/version cases.

### Controlled agent lifecycle

- Prompt acceptance through RPC stdin: passed.
- `agent_start` followed by exactly one `agent_settled`: passed.
- Post-settlement `get_state.isStreaming === false`: passed.
- Abort after a real streaming `text_delta`: passed.
- Aborted assistant message and exactly one settlement: passed.
- Same child remained responsive after streaming abort: passed.
- No later text/tool event after settlement: passed.

### Model-initiated tool cleanup

- Controlled provider emitted a real built-in `bash` tool call: passed.
- Tool started a parent and child process in Pi's managed process group and recorded both PIDs: passed.
- RPC `abort` during the model-initiated tool: passed.
- `tool_execution_end` and exactly one `agent_settled`: passed.
- Both recorded descendant PIDs exited within the bounded cleanup window: passed.

### Parent lifecycle

- Parent helper `SIGINT` used Pi Loops-owned abort/close/escalation and left no Pi child or tool descendants: passed.
- Parent helper `SIGTERM` used the same path and left no descendants: passed.
- Abrupt parent `SIGKILL` during active model-initiated tool execution: passed ten consecutive runs.
- In every forced-death run, pipe closure or the independent child deadline stopped Pi and both recorded tool descendants by deadline plus grace: passed 10/10.

### Resume and UI relay

- Persistent child session created inside an isolated temporary Git worktree: passed.
- A second Pi RPC process loaded the same session file and session ID in the same canonical worktree: passed.
- Resumed session retained messages and completed another controlled prompt: passed.
- RPC `extension_ui_request` confirmation was relayed by matching ID through `extension_ui_response`: passed.
- Extension received the response and emitted the expected notification: passed.

## Watchdog correction

The lifecycle review found that `session_shutdown` cleared the watchdog's forced-self-termination timer. That could disarm escalation if shutdown disposal hung. The watchdog now clears only the deadline-check timer; once forced termination is armed, it remains armed until process exit. A fake-timer regression test covers shutdown after escalation is armed.

## What this proves

On the tested macOS/Pi 0.80.6 baseline, a Pi Loops-owned RPC child can:

- execute a real controlled agent loop and settle deterministically;
- abort model streaming and a model-initiated built-in tool;
- clean the tool process group;
- stop cleanly on parent `SIGINT`/`SIGTERM` ownership paths;
- recover from abrupt parent death by pipe closure or absolute deadline without observed orphans;
- resume the same Pi session in the same Git worktree; and
- relay documented RPC extension UI dialogs.

This is sufficient to continue the macOS implementation slice. It is not sufficient to claim general platform support or enable Phase 2 without the remaining production components and review gates.

## Remaining blockers and limits

- The production resolver now identifies and validates the current Node CLI or current standalone `pi` executable without PATH search. Runtime evidence currently covers the Homebrew Node CLI layout; npm-global and standalone/binary layouts still require compatibility execution before support is claimed.
- Linux runtime behavior is untested. Similar Unix process-group code is not runtime evidence.
- Windows runtime behavior is untested; Pi uses a separate asynchronous `taskkill /F /T` branch.
- The UI test proves the documented RPC dialog relay. Product-specific policy/permission prompts still require integration tests when the unattended runner is implemented; silence must never count as approval.
- Worktree creation, review-branch commit/finalization, unresolved-worktree preservation, and restart reconciliation are not production code yet.
- Multi-process/crash lease stress, evaluator cancellation/provider errors, and supported-version compatibility remain open Phase 0/4 hardening work.

No scheduling or proactive writing path was enabled by this spike.
