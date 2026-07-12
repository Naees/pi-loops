import type { CompletionContract } from "../contracts/completion-contract.js";

export interface ObservedToolResult {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly content: readonly ({ readonly type: "text"; readonly text: string } | { readonly type: string })[];
  readonly isError: boolean;
}

export interface VerifierEvidence {
  readonly verifierId: string;
  readonly criterion: string;
  readonly command: string;
  readonly observed: boolean;
  readonly passed: boolean;
  readonly summary: string;
  readonly toolCallId?: string;
}

export interface CycleEvidenceCollectorOptions {
  readonly maxToolResults?: number;
  readonly maxSummaryBytes?: number;
}

interface CapturedBashResult {
  readonly toolCallId: string;
  readonly command: string;
  readonly passed: boolean;
  readonly summary: string;
}

function boundedText(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return value;
  return `${bytes.subarray(0, maxBytes).toString("utf8")}\n[truncated by Pi Loops]`;
}

export class CycleEvidenceCollector {
  readonly #maxToolResults: number;
  readonly #maxSummaryBytes: number;
  readonly #bashResults: CapturedBashResult[] = [];

  constructor(options: CycleEvidenceCollectorOptions = {}) {
    this.#maxToolResults = options.maxToolResults ?? 200;
    this.#maxSummaryBytes = options.maxSummaryBytes ?? 8 * 1024;
    if (!Number.isSafeInteger(this.#maxToolResults) || this.#maxToolResults <= 0) {
      throw new Error("maxToolResults must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.#maxSummaryBytes) || this.#maxSummaryBytes <= 0) {
      throw new Error("maxSummaryBytes must be a positive safe integer");
    }
  }

  recordToolResult(event: ObservedToolResult): void {
    if (event.toolName !== "bash" || this.#bashResults.length >= this.#maxToolResults) return;
    const command = event.input.command;
    if (typeof command !== "string" || command.trim().length === 0) return;

    const text = event.content
      .filter((block): block is { readonly type: "text"; readonly text: string } => block.type === "text" && "text" in block)
      .map((block) => block.text)
      .join("\n");
    this.#bashResults.push({
      toolCallId: event.toolCallId,
      command: command.trim(),
      passed: !event.isError,
      summary: boundedText(text, this.#maxSummaryBytes),
    });
  }

  evidenceFor(contract: CompletionContract): VerifierEvidence[] {
    return contract.verifiers.map((verifier) => {
      const result = this.#bashResults.findLast((candidate) => candidate.command === verifier.command);
      if (!result) {
        return {
          verifierId: verifier.id,
          criterion: verifier.description,
          command: verifier.command,
          observed: false,
          passed: false,
          summary: "Required verifier was not observed in this work cycle.",
        };
      }
      return {
        verifierId: verifier.id,
        criterion: verifier.description,
        command: verifier.command,
        observed: true,
        passed: result.passed,
        summary: result.summary,
        toolCallId: result.toolCallId,
      };
    });
  }

  reset(): void {
    this.#bashResults.length = 0;
  }
}

export function requiredEvidencePassed(evidence: readonly VerifierEvidence[]): boolean {
  return evidence.every((item) => item.observed && item.passed);
}
