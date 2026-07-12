# Pi prompt: design a zero-setup loop-engineering package

Paste the prompt below into Pi from the project directory.

---

You are my product-design and software-architecture partner for a new Pi package. Do not implement during the design phase. Your job in this phase is to run a disciplined back-and-forth with me until the product contract, loop semantics, architecture, dependency strategy, public UX, safety model, and repository layout are explicit enough to implement confidently. After I type the exact approval phrase defined below, implementation may begin in your following response.

## Mission

We want an npm-distributed Pi package whose canonical experience is:

```text
pi install npm:<package-name>
```

After that one install, a user with an already working Pi installation should be able to use the package immediately through natural language and/or one obvious command, with useful defaults and no package-specific setup.

The package is for **loop engineering**: it coordinates bounded coding-agent cycles such as clarify/plan, act, verify, evaluate, feed back, and retry until a declared stop condition is met. It may build on `pi-subagents`, but that is a design candidate—not a decision.

Be honest about the boundary of “zero setup.” Pi itself, a usable model/provider login or API key, project trust, and permissions required by the requested coding task may be unavoidable host prerequisites. Optional integrations must not prevent the default local workflow from working.

## Evidence to verify before relying on it

Use these sources as the starting research set. Check the current docs and source read-only, cite the exact pages you rely on, and distinguish verified facts from inferences and proposals. Do not invent Pi APIs, lifecycle hooks, paths, commands, package behavior, or `pi-subagents` integration points.

- Claude’s loop-engineering article defines a loop as repeated agent work until a stop condition and distinguishes turn-based, goal-based, time-based, and proactive loops: <https://claude.com/blog/getting-started-with-loops>
- Pi packages can expose extensions, skills, prompts, and themes through `package.json#pi`, with conventional-directory discovery as a fallback: <https://pi.dev/docs/latest/packages>
- Pi extensions expose lifecycle events, commands, tools, UI, session persistence, message injection, cancellation, and follow-up-turn mechanisms: <https://pi.dev/docs/latest/extensions>
- `pi-subagents` is a one-install Pi package that registers a `subagent` tool and supports child agents, parallel and chained runs, worktrees, budgets, acceptance gates, async status/control, artifacts, and recursion limits: <https://pi.dev/packages/pi-subagents> and <https://github.com/nicobailon/pi-subagents>
- Anthropic’s broader agent guidance recommends simple composable patterns, explicit environmental feedback, evaluator/optimizer loops when criteria are clear, fresh or independent review where useful, and iteration caps/guardrails: <https://www.anthropic.com/engineering/building-effective-agents>

Current evidence suggests that `pi-subagents` is primarily an installable extension/tool surface, not a supported JavaScript library API: its package manifest has no public `main` or `exports`. Pi’s package docs say a Pi package that includes another Pi package must bundle that dependency and explicitly reference its resources under `node_modules/...`. Verify both facts against the current published package before making a dependency recommendation.

## Design-only gate

Until I type the exact words **APPROVE IMPLEMENTATION**:

- Do not create, modify, rename, or delete files.
- Do not scaffold a package, install dependencies, run generators, change Git state, or execute mutating commands.
- Read-only repository inspection, documentation/source research, and non-mutating diagnostics are allowed.
- Do not treat “looks good,” “continue,” or approval of the design brief as permission to implement.
- If a technical fact can be learned from the repository, installed package metadata, official docs, or upstream source, research it instead of asking me to guess.
- Ask me about product intent, priorities, acceptable risks, and tradeoffs. Recommend low-level technical choices instead of turning the interview into an architecture exam.

## Temporary design-document workspace

Keep all internal design material in one repository-root folder named `.project-design/`. This folder is a temporary private working area, not part of the product or its public documentation.

- During the design-only phase, maintain the working record in the conversation because file writes are not yet authorized.
- After **APPROVE IMPLEMENTATION**, create `.project-design/` before creating implementation files and place every internal product brief, architecture document, decision record, research note, diagram source, implementation plan, spike report, and release-readiness note there.
- Use an organized structure such as `.project-design/decisions/`, `.project-design/research/`, `.project-design/diagrams/`, and `.project-design/plans/`; define the exact tree in the design brief.
- Do not scatter internal design documents through the repository root, `src/`, tests, package resources, or public `docs/`.
- Production code, tests, build scripts, and runtime behavior must never import, read, generate, or otherwise depend on `.project-design/`. Removing it must not change the build, tests, package behavior, or user experience.
- Exclude `.project-design/` from the npm package from the beginning. Verify this with the packed-artifact inspection used by the release tests.
- Immediately before the first public release, preserve any genuinely user-facing information in the appropriate public README or documentation, then remove the entire `.project-design/` folder.
- Treat removal as a release gate: the public release must fail if `.project-design/` still exists in the release tree or appears anywhere in the npm tarball. Do not remove it earlier, because it remains the source of design history during development.

## Critical distinction to preserve

Model the system as separate layers and do not collapse them into one vague “loop”:

1. Pi’s normal agent/tool-call loop inside one session.
2. The proposed package’s outer loop controller, which decides whether another bounded work cycle should run.
3. Optional `pi-subagents` child sessions, each of which may itself have multiple turns.

For every layer, identify who owns the stop decision, counters, timeout, cancellation, state, verification evidence, and error recovery. Agent reasoning may be nondeterministic; hard limits, scheduling, accounting, and terminal-state transitions should be enforced deterministically wherever Pi’s APIs allow it.

## Conversation protocol

Run an interview loop, not a one-shot questionnaire:

1. Do a brief read-only context scan first. If the repository is empty, say so and continue without scaffolding.
2. Ask one coherent batch of at most three consequential questions, all on one theme.
3. For each question, explain why it matters, give two or three concrete choices when useful, recommend one option for the MVP, and state its main tradeoff. Allow a custom answer.
4. Stop and wait for my reply. Do not ask the next batch in the same response.
5. Interpret my answers, call out ambiguity or conflicts, and update the living decision record.
6. At the start of the next round, show only the decisions or assumptions that changed, then ask the next focused batch.
7. Do not repeat questions answered directly or indirectly. If I say “you choose,” make a conservative MVP recommendation, justify it, and record it as **Proposed by Pi** rather than silently treating it as confirmed.
8. If a later answer conflicts with an earlier decision, explicitly reopen the decision; never silently rewrite history.
9. Aim to synthesize after roughly four to six useful rounds. Extend discovery only when a genuinely blocking choice remains.

Maintain this record in the conversation:

```text
Confirmed constraints
- C-001: ...

Decisions
- D-001 [Confirmed | Proposed by Pi | Reopened]
  Choice:
  Rationale:
  Consequences:

Assumptions requiring validation
- A-001: ...

Open questions
- Q-001: ...

Risks
- R-001:
  Likelihood / impact:
  Mitigation:

Rejected alternatives
- X-001:
  Reason:

Evidence
- E-001 [Verified fact | Inference]: claim — source or validation needed
```

During ordinary rounds, show only the latest delta. Include the complete record in the final design brief.

## Discovery order

Cover these themes in order, adapting when an answer makes a later theme irrelevant.

### 1. Product contract and 60-second journey

Establish the target user, the exact install-to-first-success flow, what “instant use” means, whether the primary interface is natural language, a slash command, a model-facing tool, or a combination, and which unavoidable prerequisites are outside the package’s promise.

### 2. MVP loop semantics

Decide whether v1 provides one opinionated bounded goal loop or a general framework. Define the default cycle, success evidence, evaluator behavior, maximum iterations, no-progress detection, terminal failure reasons, and when human approval is required. Explicitly decide whether time-based/proactive loops belong in v1; an always-on or external-event loop cannot be promised merely by installing an extension if Pi is not running.

### 3. Control, safety, and budgets

Define hard defaults for iteration count, wall time, agent turns, tool calls, concurrency, recursion, token/cost accounting where available, and repeated-failure thresholds. Define cancellation, interruption, process-exit behavior, destructive-action confirmation, network side effects, secrets/log redaction, and whether writers use the main working tree, checkpoints, branches, or isolated worktrees.

### 4. Subagent and dependency strategy

Inspect the current Pi and `pi-subagents` source and explicitly compare at least these options:

- Build a thin declarative package on supported `pi-subagents` package-supplied agent/chain surfaces plus our prompts and skills, adding custom extension code only for proven gaps. First verify the current manifest keys and determine whether existing budgets, acceptance gates, status, cancellation, and resume already satisfy the MVP.
- Bundle and compose the `pi-subagents` extension as a pinned/bundled dependency, with our own prompt/skill/extension layered around its registered tool.
- Soft-integrate with an already registered `subagent` tool and provide a clear fallback; explain why this alone may violate the one-install promise.
- Maintain a namespaced adapter or attributed fork of the required orchestration pieces.
- Build a smaller first-party child-runner using supported Pi APIs or child-process/RPC interfaces.

For each option, assess zero-setup behavior, use of supported APIs, deterministic control, maintenance burden, published-package contents, license/attribution, Pi version compatibility, upstream version coupling, security review, and testability.

Pi currently documents `pi.getAllTools()` for inspecting configured tools and their provenance; verify its current behavior. Do not confuse registry inspection with access to another tool’s executable implementation. Whether one extension can directly invoke another extension’s registered tool remains a separate question to verify or cover with a small implementation spike after design approval. Also resolve:

- What happens when the user already installed `pi-subagents` and our bundle would register the same `subagent` tool?
- Do we need its extension only, or also its skills and prompts?
- How are tool, command, skill, prompt, config, artifact, and event names namespaced?
- Is an exact upstream pin required, and what is the upgrade policy?

### 5. State, UX, and recovery

Define the public command/tool/prompt contract and the state machine. At minimum, reason about states equivalent to configuring, preflight, running, verifying, evaluating, awaiting user, completed, failed, cancelled, budget exhausted, and stalled/no progress. Decide what persists, what can resume after restart, how duplicate triggers are handled, how concurrent loops are isolated, and what users see for status, evidence, cost/usage, stop, and resume.

### 6. Package boundary, layout, and validation

Define the package manifest, runtime versus peer/bundled dependencies, supported Pi/Node/OS ranges, component boundaries, repository tree, `.project-design/` organization, configuration precedence, schema/versioning, logging/artifacts, and release process. A clean-install end-to-end test from a packed tarball is mandatory. Include duplicate-install, missing/old dependency, cancellation, timeout, failed verification, no-progress, crash cleanup, parallel-write isolation, upgrade/migration tests where relevant, and an automated release check proving `.project-design/` is absent from both the release tree and packed artifact.

## Provisional architecture hypothesis to challenge

Treat this as a starting hypothesis, not a decision:

- Ship a Pi-native package with one opinionated, bounded, goal-based coding loop and progressive configuration after the default path works.
- First test whether a thin declarative layer over supported Pi and `pi-subagents` primitives already satisfies the MVP. Add a small deterministic controller only for specific, evidenced gaps in state transitions, hard limits, cancellation, evidence collection, or terminal outcomes.
- Use agents/subagents for planning, implementation, critique, and judgment, but never let prompt text be the only enforcement mechanism for budgets or stopping.
- Put subagent execution behind an internal adapter so the product contract is not inseparable from one upstream tool schema.
- Prefer deterministic verification commands/metrics before model judgment, followed by an optional fresh-context reviewer.
- Store a schema-versioned run record with iteration summaries, evidence, verifier outputs, decisions, usage, and artifact pointers; avoid treating the entire chat transcript as the only durable state.
- Keep v1 smaller than a general workflow platform. Defer time-based and proactive scheduling unless the product contract clearly requires and can honestly support them.

Try to disprove this hypothesis with evidence. If you recommend a different architecture, show why it better satisfies the one-install experience and the agreed constraints.

## Required final design brief

When the consequential choices are stable, produce a design brief containing:

- Product brief, target user, non-goals, and exact “zero-setup” contract.
- A literal install-to-first-success walkthrough.
- MVP user stories and testable acceptance criteria.
- Verified research findings, open technical spikes, and source links.
- The chosen architecture plus at least two credible alternatives and their tradeoffs.
- A layered execution diagram showing parent Pi, outer controller, optional child agents, verifiers/evaluator, storage, and user checkpoints.
- A loop state machine with every entry, transition, guard, stop reason, cancellation path, budget-exhaustion path, and resume rule.
- Subagent roles, context handoff, fresh versus forked context, concurrency, worktree/isolation, review independence, and conflict handling.
- Public natural-language behavior, commands, tools, prompt/skill names, defaults, optional config, and namespace/collision policy.
- Package manifest/dependency strategy, including the exact `pi-subagents` integration decision and compatibility/update policy.
- Component responsibilities, data flow, schemas, persistence, observability, security boundaries, and error model.
- A proposed repository tree with the purpose of every major file or directory.
- The proposed `.project-design/` tree, its document ownership rules, and the exact pre-release removal/check procedure.
- Unit, integration, real-session, clean-install, compatibility, cancellation, failure-recovery, and release tests.
- MVP milestones in implementation order, with explicit exit criteria.
- The complete decision, assumption, risk, rejection, and evidence record.

End the brief by asking whether I want to revise it, reopen a decision, request a technical spike, or type **APPROVE IMPLEMENTATION**. Do not begin implementation in the same response as the brief.

## Your first response

Do not produce an architecture or repository tree yet. After a short read-only context assessment, ask exactly these three product-contract questions, with a recommendation and tradeoff for each, then stop:

1. What should the literal first 60 seconds look like after `pi install npm:<package-name>`: natural-language use, one slash command, or both?
2. Does “zero setup” mean no package-specific configuration inside an already authenticated Pi installation, or must the product also work as a standalone/always-on service?
3. For v1, should we perfect one opinionated bounded goal loop, or expose multiple loop types and a user-configurable framework immediately?

---

End of prompt.
