# Research: zero-setup Pi package using `pi-subagents`

## Summary

The current published package is `pi-subagents@0.34.0` (published 2026-07-07); the inspected repository HEAD is `c940fe20e86d9ba429eebcac809ec79d478ef206` (2026-07-10), so HEAD contains a small unreleased addition (agent-level launch defaults) beyond the tarball. The package is already a zero-setup Pi package: its manifest declares one TypeScript extension, one skill directory, and one prompt directory, and bundles the full runner plus eight agents and seven prompt workflows. It is **not** a reusable JavaScript library: there is no `main` or `exports` field and no stable public JS API.

For a new package, the lowest-risk designs are thin declarative agents/prompts or soft integration over the installed `subagent` tool. Bundling a second copy creates tool/command-name collisions and duplicated runtime state; direct cross-extension executor invocation is not supported by current Pi—`getAllTools()` exposes metadata, not `execute`—so a hard in-process adapter requires an explicit event/RPC contract, a fork, or a first-party runner.

## Findings

### 1. Published manifest and package contents (verified)

1. **Version and Pi resource keys.** The current manifest is version `0.34.0`, ESM, MIT, and declares:
   - `pi.extensions: ["./src/extension/index.ts"]`
   - `pi.skills: ["./skills"]`
   - `pi.prompts: ["./prompts"]`
   - bin `pi-subagents -> install.mjs`
   - package files: `src/**/*.ts`, `*.mjs`, `agents/`, `skills/**/*`, `prompts/**/*`, README, CHANGELOG.
   Exact manifest evidence: [`package.json` lines 1–70](https://github.com/nicobailon/pi-subagents/blob/c940fe20e86d9ba429eebcac809ec79d478ef206/package.json#L1-L70). Registry evidence: [npm registry metadata](https://registry.npmjs.org/pi-subagents).

2. **No library entry point/public JS API.** The manifest has neither `main` nor `exports`; only the Pi extension path and CLI bin are entry points. `src/extension/index.ts` does export `loadConfig`, but without a package export map/main this is an internal source-path import, not a promised package API. Evidence: [manifest](https://github.com/nicobailon/pi-subagents/blob/c940fe20e86d9ba429eebcac809ec79d478ef206/package.json#L1-L70), [`index.ts` export](https://github.com/nicobailon/pi-subagents/blob/c940fe20e86d9ba429eebcac809ec79d478ef206/src/extension/index.ts#L44-L68).

3. **Published payload is source, not compiled JS.** Unpkg’s exact `0.34.0` inventory lists 112 files / about 1.8 MB unpacked, including TypeScript under `src`, eight agent Markdown files, seven prompt Markdown files, one skill, `install.mjs`, README and CHANGELOG. It contains no `dist/`, compiled extension JS, tests, or LICENSE file. [Exact unpkg file inventory](https://unpkg.com/pi-subagents@0.34.0/?meta).

4. **Bundled names.** Agents are `context-builder`, `delegate`, `oracle`, `planner`, `researcher`, `reviewer`, `scout`, and `worker`; prompts are `gather-context-and-clarify`, `parallel-cleanup`, `parallel-context-build`, `parallel-handoff-plan`, `parallel-research`, `parallel-review`, and `review-loop`; the skill name is `pi-subagents`. These names are independently visible in the immutable package inventory above and repository tree. [Agents directory](https://github.com/nicobailon/pi-subagents/tree/c940fe20e86d9ba429eebcac809ec79d478ef206/agents), [prompts directory](https://github.com/nicobailon/pi-subagents/tree/c940fe20e86d9ba429eebcac809ec79d478ef206/prompts), [skill frontmatter](https://github.com/nicobailon/pi-subagents/blob/c940fe20e86d9ba429eebcac809ec79d478ef206/skills/pi-subagents/SKILL.md#L1-L8).

### 2. Runtime surface and orchestration capabilities (verified)

5. **Tools.** The extension registers exactly two parent-facing tools: `subagent` and `wait`. `subagent` dispatches its own executor; `wait` blocks for first/all/specific async child completion or attention. [`index.ts` tool definitions/registrations](https://github.com/nicobailon/pi-subagents/blob/c940fe20e86d9ba429eebcac809ec79d478ef206/src/extension/index.ts#L315-L407).

6. **Commands.** The built-in command surface includes `/run`, `/chain`, `/parallel`, `/run-chain`, `/subagents-doctor`, `/subagents-models`, `/subagents-fleet`, `/subagents-stop`, `/subagents-watchdog`, plus prompt bridge commands `/prompt-workflow` and `/chain-prompts`. The latter two are explicitly registered in [`prompt-workflows.ts`](https://github.com/nicobailon/pi-subagents/blob/c940fe20e86d9ba429eebcac809ec79d478ef206/src/slash/prompt-workflows.ts#L225-L302); the main set is registered in [`slash-commands.ts`](https://github.com/nicobailon/pi-subagents/blob/c940fe20e86d9ba429eebcac809ec79d478ef206/src/slash/slash-commands.ts). (Implementation should enumerate `pi.getCommands()` in a live install before treating this as an exhaustive compatibility contract.)

7. **Declarative agents and chains.** Agent Markdown supports frontmatter-driven model/thinking/tools/skills/extensions/context/output/reads/progress/acceptance and nested-depth behavior. Chains support sequential steps, static parallel groups, dynamic expansion from prior structured output, named outputs, JSON schema, concurrency, fail-fast, and per-parallel-task worktrees. The tool schema is exact evidence: [`schemas.ts` chain/task shapes](https://github.com/nicobailon/pi-subagents/blob/c940fe20e86d9ba429eebcac809ec79d478ef206/src/extension/schemas.ts#L54-L180). Installed packages may declaratively expose agents with either `pi-subagents.agents` or `pi.subagents.agents`; package agents are namespaced and precedence is documented in the [README agent-discovery section](https://github.com/nicobailon/pi-subagents/blob/c940fe20e86d9ba429eebcac809ec79d478ef206/README.md#L620-L692).

8. **Budgets/deadlines.** Run-level `timeoutMs`/`maxRuntimeMs`, soft+grace assistant `turnBudget`, and soft/hard/blocking `toolBudget` exist. Tool budget defaults to blocking read/search-style tools after the hard threshold while permitting finalization; `block: "*"` can block all. Per-run, agent, step and parallel-task overrides are represented in schema. [`schemas.ts` budget definitions](https://github.com/nicobailon/pi-subagents/blob/c940fe20e86d9ba429eebcac809ec79d478ef206/src/extension/schemas.ts#L35-L83), [`turn-budget.ts`](https://github.com/nicobailon/pi-subagents/blob/c940fe20e86d9ba429eebcac809ec79d478ef206/src/runs/shared/turn-budget.ts#L1-L58), [`tool-budget.ts`](https://github.com/nicobailon/pi-subagents/blob/c940fe20e86d9ba429eebcac809ec79d478ef206/src/runs/shared/tool-budget.ts).

9. **Acceptance.** Accepted policy inputs are `auto`, `none`, `attested`, `checked`, `verified`, `reviewed`, `false`, or a policy object. Completion guards parse a fenced `acceptance-report`, check evidence and can run configured verification commands; `reviewed` adds review evidence. This is a workflow gate, not a security sandbox. [`schemas.ts` acceptance enum](https://github.com/nicobailon/pi-subagents/blob/c940fe20e86d9ba429eebcac809ec79d478ef206/src/extension/schemas.ts#L27-L39), [`acceptance.ts`](https://github.com/nicobailon/pi-subagents/blob/c940fe20e86d9ba429eebcac809ec79d478ef206/src/runs/shared/acceptance.ts).

10. **Async lifecycle.** `async: true` launches background work; actions include `status`, transcript/fleet views, `interrupt`, `stop`, `resume`, `steer`, and chain `append-step`. Resume accepts a follow-up `message` and child `index`; `wait` supports first/all/id and timeout. Exact action/id fields: [`schemas.ts` management fields](https://github.com/nicobailon/pi-subagents/blob/c940fe20e86d9ba429eebcac809ec79d478ef206/src/extension/schemas.ts#L192-L279); registration of both tools: [`index.ts`](https://github.com/nicobailon/pi-subagents/blob/c940fe20e86d9ba429eebcac809ec79d478ef206/src/extension/index.ts#L315-L407).

11. **Worktrees and artifacts.** `worktree: true` is supported for top-level parallel tasks and parallel chain steps and requires a clean Git state; worktree setup hooks are configurable. Artifacts are on by default, with optional `chainDir`, output files/file-only mode, progress, sessions, and machine-readable async lifecycle files. [`schemas.ts` worktree/artifact fields](https://github.com/nicobailon/pi-subagents/blob/c940fe20e86d9ba429eebcac809ec79d478ef206/src/extension/schemas.ts#L165-L180), [`worktree.ts`](https://github.com/nicobailon/pi-subagents/blob/c940fe20e86d9ba429eebcac809ec79d478ef206/src/runs/shared/worktree.ts), [`artifacts.ts`](https://github.com/nicobailon/pi-subagents/blob/c940fe20e86d9ba429eebcac809ec79d478ef206/src/shared/artifacts.ts).

12. **Recursion is intentionally bounded, not absent.** Child processes set `PI_SUBAGENT_CHILD`; the extension’s default registration exits immediately in children, while explicit nested delegation is mediated through child-specific extension/runtime plumbing and `maxSubagentDepth`. The extension comment shows default config `maxSubagentDepth: 1`, and async parameters carry the resolved depth. [`index.ts` child guard](https://github.com/nicobailon/pi-subagents/blob/c940fe20e86d9ba429eebcac809ec79d478ef206/src/extension/index.ts#L1-L18), [`index.ts` registration guard](https://github.com/nicobailon/pi-subagents/blob/c940fe20e86d9ba429eebcac809ec79d478ef206/src/extension/index.ts#L145-L153), [`fanout-child.ts`](https://github.com/nicobailon/pi-subagents/blob/c940fe20e86d9ba429eebcac809ec79d478ef206/src/extension/fanout-child.ts). Treat deeper recursion as opt-in and test it; do not infer unlimited recursive loading.

### 3. Compatibility, licensing, and extension composition

13. **Pi compatibility.** Published `0.34.0` develops against Pi `0.74.0`; `@earendil-works/pi-tui` is pinned to `0.74.0`, while agent-core/ai/coding-agent are optional `*` peers and `0.74.0` dev dependencies. This strongly supports Pi 0.74.0, but the wildcard peers do **not** prove all future Pi versions compatible. [Manifest dependencies](https://github.com/nicobailon/pi-subagents/blob/c940fe20e86d9ba429eebcac809ec79d478ef206/package.json#L48-L70).

14. **License/attribution gap.** The manifest says MIT and author Nico Bailon, but neither repository HEAD nor the published tarball contains a LICENSE file (raw `/LICENSE` is 404; unpkg inventory has none). Consequently, a bundle/fork should not merely rely on npm metadata: obtain/confirm the upstream MIT license text and preserve copyright/attribution before redistribution. Verified evidence is the [manifest license/author](https://github.com/nicobailon/pi-subagents/blob/c940fe20e86d9ba429eebcac809ec79d478ef206/package.json#L1-L15) plus [published inventory](https://unpkg.com/pi-subagents@0.34.0/?meta). The legal consequence is implementation guidance, not legal advice.

15. **No direct cross-extension tool invocation API (verified).** Current Pi’s `ExtensionAPI` has `registerTool`, `getActiveTools`, and `getAllTools`; `ToolInfo` is only a pick of name/description/parameters/promptGuidelines plus source metadata—no executor. [`ExtensionAPI` and `ToolInfo`](https://github.com/badlogic/pi-mono/blob/38f18be4/packages/coding-agent/src/core/extensions/types.ts#L1000-L1135). The open request explicitly confirms `execute` is stripped and proposes `getToolExecutor`; workarounds use `globalThis` or `pi.events`. [Pi issue #2420](https://github.com/badlogic/pi-mono/issues/2420). Therefore one extension can inspect availability/schema/source via `pi.getAllTools()`, but cannot directly call another extension’s registered implementation through the supported API.

16. **Duplicate standalone + bundled loading (verified mechanics; runtime outcome needs spike).** Each copy registers tools named `subagent` and `wait` and the same slash commands; the extension has global cleanup keys for stale timers/event subscriptions but **no guard that skips duplicate tool or command registration**. [`index.ts` registration](https://github.com/nicobailon/pi-subagents/blob/c940fe20e86d9ba429eebcac809ec79d478ef206/src/extension/index.ts#L145-L407). Pi intentionally allows same-name tools to override built-ins, so same-name registration is meaningful rather than namespaced ([official override example](https://github.com/badlogic/pi-mono/blob/38f18be4/packages/coding-agent/examples/extensions/tool-override.ts)). **Inference:** load order likely determines the active definition, while both factories may retain watchers/state and commands may collide or overwrite/warn. Do not ship both copies without a live two-copy test; the exact warning/error/last-wins behavior for duplicate extension tools *and commands* remains an implementation spike.

### 4. Design comparison

| Option | Zero setup | Coupling / fidelity | Duplicate risk | Recommendation |
|---|---:|---|---|---|
| **Thin declarative use**: package only agents/prompts/skill metadata and require `pi-subagents` installed | High after dependency install | Uses documented declarative surface; lowest maintenance | None if it does not bundle/load runner | **Best default** when Pi package dependency/install ordering can be guaranteed. |
| **Bundled composition**: include upstream package/copy as part of yours | Superficially highest | Full features, but pins internals/source layout | **High** if user also installs standalone; license payload issue | Avoid unless you can detect/suppress one registration and validate attribution. |
| **Soft integration**: own extension checks `getAllTools()` and instructs the model/calls event or prompt bridge | High | Availability/schema inspection is supported; execution is indirect | Low | **Best extension-level integration**. Prefer an explicit upstream event/RPC bridge over pretending `getAllTools()` is callable. |
| **Adapter/fork** | High | Can expose a stable API and customize behavior, but tracks a fast-moving ~1.8 MB codebase | Medium; namespace tools/commands | Use only for required semantics unavailable declaratively; preserve upstream attribution and add conformance tests. |
| **First-party runner** | High | Maximum control and stable own API; reimplements async/process/worktree/artifact/acceptance complexity | None if uniquely named | Only justified when subagents is core product infrastructure and long-term maintenance is funded. |

**Recommended architecture:** publish declarative agents/prompts/skill and a very small extension that (a) checks `pi.getAllTools()` for a tool named `subagent` and source information, (b) provides clear install/compatibility diagnostics, and (c) uses a documented Pi event/RPC handshake if programmatic execution is essential. Do not import `pi-subagents/src/...` as a public API and do not embed/register a second copy by default.

## Facts vs inference vs required spikes

### Verified facts
- Published version/resources/files/names, lack of `main`/`exports`, TypeScript source payload, tools and schema capabilities, Pi 0.74.0 dependency evidence, manifest MIT claim, missing LICENSE payload, and `getAllTools()` lacking executors.
- Repository HEAD differs from the 0.34.0 publish: HEAD adds agent-level defaults for async/timeout/turn budget ([HEAD commit](https://github.com/nicobailon/pi-subagents/commit/c940fe20e86d9ba429eebcac809ec79d478ef206)); published tarball evidence remains version-pinned at unpkg.

### Inference
- A declarative/soft integration will have much lower maintenance and collision risk than bundling/forking.
- With two copies, load order probably selects the effective same-name tools while duplicate side effects may survive; exact behavior is not established by static inspection.
- Wildcard optional peers indicate tolerance, not guaranteed compatibility with every Pi release.

### Implementation spikes still needed
1. Install a fixture Pi package exposing `pi.subagents.agents` and verify Pi installation order/dependency behavior from a clean home directory.
2. Load standalone `pi-subagents@0.34.0` plus a bundled copy in both orders; capture startup diagnostics, `getAllTools()`, `getCommands()`, active executor behavior, watchers, async notifications, and shutdown cleanup.
3. Prototype an event/RPC request-response bridge and test timeout, cancellation, reload/stale contexts, and version negotiation. Upstream already contains internal bridges, but they are not a package public API.
4. Run a compatibility matrix against Pi 0.74.0 and the intended minimum/latest versions, including Node’s TypeScript loading.
5. Confirm upstream licensing with the maintainer and include the actual license/copyright notice before any vendoring or fork.
6. Enumerate live command names from `pi.getCommands()` to freeze only the subset the new package relies on.

## Sources

- **Kept:** [`package.json` at inspected HEAD](https://github.com/nicobailon/pi-subagents/blob/c940fe20e86d9ba429eebcac809ec79d478ef206/package.json) — exact manifest, package resources, dependency and license evidence.
- **Kept:** [unpkg `0.34.0` metadata](https://unpkg.com/pi-subagents@0.34.0/?meta) — immutable published file inventory.
- **Kept:** [`src/extension/index.ts`](https://github.com/nicobailon/pi-subagents/blob/c940fe20e86d9ba429eebcac809ec79d478ef206/src/extension/index.ts) and [`schemas.ts`](https://github.com/nicobailon/pi-subagents/blob/c940fe20e86d9ba429eebcac809ec79d478ef206/src/extension/schemas.ts) — actual tool registration and declarative runtime schema.
- **Kept:** [Pi extension types](https://github.com/badlogic/pi-mono/blob/38f18be4/packages/coding-agent/src/core/extensions/types.ts) and [issue #2420](https://github.com/badlogic/pi-mono/issues/2420) — primary API definition plus explicit executor-access gap.
- **Dropped:** jsDelivr summary — stale version (`0.11.3`) and redundant with registry/unpkg.
- **Dropped:** forks and third-party project pages — not authoritative for current upstream behavior.
- **Dropped:** search snippets referencing old root-level source paths — repository was reorganized under `src/` and immutable HEAD files are stronger evidence.

## Gaps

No repository or package was modified. Static research cannot establish the exact duplicate-registration diagnostics/precedence or clean-install dependency ordering; those require the listed isolated runtime spikes. The repository’s absent LICENSE text also prevents confident redistribution guidance beyond preserving attribution and obtaining the canonical license text.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Completed read-only research at the requested artifact path without modifying the target repository or package."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "Brief provides immutable GitHub permalinks, version-pinned unpkg manifest evidence, primary Pi API evidence, explicit fact/inference/spike separation, and residual gaps."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "fetch GitHub repository, GitHub API HEAD/tag, raw source files, npm registry, and unpkg package metadata",
      "result": "passed",
      "summary": "Verified repository HEAD c940fe20e86d9ba429eebcac809ec79d478ef206, published 0.34.0 manifest, and 112-file package inventory."
    },
    {
      "command": "focused web searches across manifest/resources, runtime features, package publication, and Pi extension tool API",
      "result": "passed",
      "summary": "Corroborated feature surface and located primary Pi API/issue evidence."
    }
  ],
  "validationOutput": [
    "Published package manifest version is 0.34.0 with pi.extensions, pi.skills, and pi.prompts keys.",
    "No main or exports field and no compiled dist/public JS entry were found.",
    "Unpkg metadata reports the complete 0.34.0 payload; LICENSE is absent.",
    "Pi ExtensionAPI ToolInfo excludes execute; issue #2420 requests the missing executor accessor.",
    "Requested output file was created; target repository/package remained read-only."
  ],
  "residualRisks": [
    "Exact duplicate tool/command registration behavior requires a live two-copy Pi fixture.",
    "Clean-install package dependency/resource ordering and broader Pi version compatibility require matrix tests.",
    "Canonical MIT license text/copyright notice should be confirmed before redistribution."
  ],
  "noStagedFiles": true,
  "diffSummary": "No repository diff; only the mandated external research artifact was written.",
  "reviewFindings": [
    "no blockers in the research deliverable; runtime spikes are clearly identified"
  ],
  "manualNotes": "Read-only scope means no tests or repository changes were made. The output artifact itself is intentionally not listed as a target repository changed file."
}
```
