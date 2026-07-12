import type { CompletionContract } from "../contracts/completion-contract.js";
import type { VerifierEvidence } from "../evidence/collector.js";
import { createDeterministicFailureDecision, type EvaluationDecision } from "../evidence/evaluator.js";
import { DEFAULT_CONFIG } from "../config/config.js";
import { createRunId } from "../shared/ids.js";
import { truncateUtf8 } from "../shared/text.js";
import type { RunBudget, RunRecord } from "../shared/types.js";
import type { RunStore } from "../storage/run-store.js";

export function abortableDelay(ms: number, signal: AbortSignal, abortMessage = "Operation aborted"): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException(abortMessage, "AbortError"));
  return new Promise((resolveDelay, rejectDelay) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolveDelay();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      rejectDelay(new DOMException(abortMessage, "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function createUniqueRunId(store: RunStore): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const runId = createRunId();
    if ((await store.load(runId)) === undefined) return runId;
  }
  throw new Error("Could not allocate a unique run ID");
}

export function resolveBudget(override: Partial<RunBudget> | undefined): RunBudget {
  const budget = { ...DEFAULT_CONFIG.defaults, ...override };
  for (const [name, value] of Object.entries(budget)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  }
  return budget;
}

export function boundedRecordText(value: string, maxBytes: number): string {
  return truncateUtf8(value, maxBytes);
}

export function deterministicFailureDecision(evidence: readonly VerifierEvidence[]): EvaluationDecision {
  const failed = evidence.filter((item) => !item.observed || !item.passed);
  return createDeterministicFailureDecision(failed);
}

export function buildWorkMessage(run: RunRecord, contract: CompletionContract, feedback: string | undefined): string {
  const verifierText = contract.verifiers.length === 0
    ? "No deterministic verifier was declared. Surface concrete evidence that demonstrates the goal."
    : contract.verifiers.map((verifier) => `- Run exactly: ${verifier.command}`).join("\n");
  const constraintText = contract.constraints.length === 0
    ? "- No additional constraints were declared."
    : contract.constraints.map((constraint) => `- ${constraint}`).join("\n");
  return `Pi Loops attended goal — ${run.runId}\n\nGoal:\n${contract.goal}\n\nRequired verification:\n${verifierText}\n\nConstraints:\n${constraintText}\n\nCycle: ${run.cycle + 1} of ${run.budget.maxCycles}\n${feedback ? `\nFeedback from the previous cycle:\n${feedback}\n` : ""}\nContinue working toward the goal. Run required verifiers through normal Pi tools and surface their results. Do not claim completion while delegated work remains outstanding.`;
}

export function formatContract(run: RunRecord, contract: CompletionContract): string {
  const verifiers = contract.verifiers.length === 0 ? "model-evaluated evidence" : contract.verifiers.map((item) => item.command).join(", ");
  return `${run.runId} started\nGoal: ${contract.goal}\nVerification: ${verifiers}\nBudget: ${run.budget.maxCycles} cycles / ${Math.round(run.budget.maxActiveMs / 60_000)} minutes`;
}

export function retentionEligible(run: RunRecord): boolean {
  if (run.worker?.worktreeRetained) return false;
  return run.state === "completed" || run.state === "cancelled" || (run.state === "failed" && run.failureRecoverable === false);
}

export function formatRunStatus(run: RunRecord): string {
  const evidence = run.latestEvidence ?? [];
  const passed = evidence.filter((item) => item.observed && item.passed).length;
  const reason = run.terminalReason ?? run.latestEvaluation?.reason;
  const verification = evidence.length === 0
    ? "no deterministic verifier evidence"
    : `${passed}/${evidence.length} required verifier(s) passed`;
  return [
    `${run.runId}  ${run.state}  cycles=${run.totalCycles ?? run.cycle}  updated=${run.updatedAt}`,
    `  goal: ${boundedRecordText(run.goal, 2 * 1024)}`,
    `  verification: ${verification}`,
    ...(reason ? [`  reason: ${boundedRecordText(reason, 2 * 1024)}`] : []),
  ].join("\n");
}
