# RPC Worker Spike — Initial Handshake

**Date:** 2026-07-12  
**Platform:** macOS (Homebrew Pi installation)  
**Pi:** 0.80.6  
**Node:** 25.1.0

## Purpose

Validate the smallest child-process premise before implementing the production worker manager: launch the current Pi executable in RPC mode without a shell, load the local extension in child mode, perform a JSONL state handshake, close stdin, and observe a clean exit.

## Command

```text
node scripts/spike-rpc-worker.mjs
```

The script resolved Pi to `/opt/homebrew/bin/pi` and launched it with an argument array equivalent to:

```text
pi --mode rpc --no-session --extension <absolute-extension-path>
```

It set a unique `PI_LOOPS_CHILD` marker and sent `get_state` through stdin as JSONL.

## Observed result

- RPC process spawn: passed.
- `get_state` request/response handshake: passed.
- Child-mode extension suppression: loaded without registering the outer controller.
- Closing RPC stdin after the handshake: child exited normally with status 0.
- Shell interpolation: not used (`shell: false`).
- Task prompt in process arguments: no task prompt was present.

## What this proves

The installed Pi CLI can be supervised as an attached RPC child on the development machine, and an idle child exits cleanly when its RPC input closes.

## What this does not prove

The mandatory Phase 0 spike remains incomplete until tests cover:

- A real or controlled agent prompt and `agent_settled`.
- RPC abort during model streaming.
- RPC abort during a tool subprocess.
- Parent `SIGINT`, `SIGTERM`, and forced death.
- Child-side absolute deadline after parent loss.
- Descendant-process cleanup.
- Session persistence and resume in the same worktree.
- Permission/UI request relaying.
- npm-installed versus standalone/binary Pi executable resolution.
- Linux and Windows process behavior.

These items continue to gate scheduled/proactive writing. They do not block the attended Phase 1 goal-loop slice.
