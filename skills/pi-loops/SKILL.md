---
name: pi-loops
description: Use bounded Pi Loops attended goal workflows when a user asks to keep iterating until a condition is met, inspect goal-loop status, stop work, or resume an interrupted run.
---

# Pi Loops

Use the `pi_loops` tool for persistent attended goal-loop state. Use `/loops` when giving the user an explicit command example. Scheduling and proactive triggers are not implemented yet.

## Goal quality

A goal should include:

1. One measurable end state.
2. The check that demonstrates that state where possible.
3. Constraints that must remain true.
4. A finite cycle and time budget.

Respect explicit user criteria. If criteria are absent, inspect existing project scripts, tests, build configuration, and task wording, then make the inferred contract visible. Ask only when material ambiguity remains.

## Completion

Never claim completion while a required deterministic check is missing or failing. Surface verifier commands and results in the conversation so the independent evaluator can judge them.

If another installed tool delegates work, await that work before claiming completion. Do not treat a background launch as completed work.

## Runtime boundary

Pi Loops runs only while Pi is running. Do not imply that local schedules continue after Pi exits.

`pi-subagents` is optional. It may be useful for parallel workers or independent reviews when installed, but ordinary Pi Loops goals must not require it.
