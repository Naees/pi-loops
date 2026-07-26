import { complete, type UserMessage } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { COMPLETION_LIMITS } from "../contracts/completion-limits.js";
import { errorMessage } from "../shared/errors.js";
import { truncateUtf8 } from "../shared/text.js";
import type { StoredEvaluationDecision } from "../shared/types.js";
import { isRecord } from "../shared/validation.js";
import {
  hasCoherentEvaluationDecision,
  hasEvaluationDecisionShape,
  unknownEvaluationDecisionKeys,
} from "./evaluation-decision.js";

export interface EvaluationInput {
  readonly goal: string;
  readonly constraints: readonly string[];
  readonly workerSummary: string;
  readonly verifierEvidence: readonly {
    readonly criterion: string;
    readonly passed: boolean;
    readonly summary: string;
  }[];
  readonly previousFeedback?: string;
}

export interface EvaluationDecision extends StoredEvaluationDecision {}

export interface CompletionEvaluator {
  evaluate(input: EvaluationInput, signal?: AbortSignal): Promise<EvaluationDecision>;
}

export function createDeterministicFailureDecision(
  failedEvidence: readonly { readonly criterion: string; readonly summary: string }[],
): EvaluationDecision {
  return {
    complete: false,
    needsUser: false,
    reason: "Required deterministic verification is failing or missing.",
    failedCriteria: failedEvidence.map((evidence) => evidence.criterion),
    feedback: failedEvidence.map((evidence) => `${evidence.criterion}: ${evidence.summary}`).join("\n"),
  };
}

export class EvaluatorUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvaluatorUnavailableError";
  }
}

export class InvalidEvaluatorResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidEvaluatorResponseError";
  }
}

const MAX_EVALUATOR_TEXT_BYTES = 32 * 1024;
const MAX_EVALUATOR_PAYLOAD_BYTES = 128 * 1024;

const SYSTEM_PROMPT = `You are an independent completion evaluator for a bounded coding loop.
Judge only whether the declared goal and constraints are satisfied by the supplied evidence.
Required deterministic verifier failures or missing evidence can never be overridden.
Return exactly one JSON object with this shape:
{"complete":boolean,"needsUser":boolean,"reason":string,"failedCriteria":string[],"feedback":string|null}
Do not include markdown, commentary, or tool calls.`;

function boundedEvaluationInput(input: EvaluationInput): EvaluationInput {
  return {
    goal: truncateUtf8(input.goal, MAX_EVALUATOR_TEXT_BYTES),
    constraints: input.constraints.slice(0, COMPLETION_LIMITS.constraintCount)
      .map((constraint) => truncateUtf8(constraint, COMPLETION_LIMITS.itemBytes)),
    workerSummary: truncateUtf8(input.workerSummary, MAX_EVALUATOR_TEXT_BYTES),
    verifierEvidence: input.verifierEvidence.slice(0, COMPLETION_LIMITS.verifierCount).map((evidence) => ({
      criterion: truncateUtf8(evidence.criterion, COMPLETION_LIMITS.itemBytes),
      passed: evidence.passed,
      summary: truncateUtf8(evidence.summary, 8 * 1024),
    })),
    ...(input.previousFeedback === undefined ? {} : { previousFeedback: truncateUtf8(input.previousFeedback, 8 * 1024) }),
  };
}

export function parseEvaluationDecision(text: string): EvaluationDecision {
  if (Buffer.byteLength(text, "utf8") > 64 * 1024) {
    throw new InvalidEvaluatorResponseError("Evaluator response exceeds 65536 bytes");
  }
  let value: unknown;
  try {
    value = JSON.parse(text.trim()) as unknown;
  } catch (error) {
    throw new InvalidEvaluatorResponseError(`Evaluator returned invalid JSON: ${errorMessage(error)}`);
  }

  if (!isRecord(value)) throw new InvalidEvaluatorResponseError("Evaluator response must be an object");
  const unknown = unknownEvaluationDecisionKeys(value);
  if (unknown.length > 0) throw new InvalidEvaluatorResponseError(`Unknown evaluator field(s): ${unknown.join(", ")}`);
  if (!hasEvaluationDecisionShape(value)) throw new InvalidEvaluatorResponseError("Evaluator response has an invalid shape");
  if (!hasCoherentEvaluationDecision(value)) {
    if (value.complete && value.needsUser) {
      throw new InvalidEvaluatorResponseError("A completed evaluation cannot also require the user");
    }
    throw new InvalidEvaluatorResponseError("A completed evaluation cannot contain failed criteria");
  }
  return value;
}

export class CurrentModelEvaluator implements CompletionEvaluator {
  readonly #context: Pick<ExtensionContext, "model" | "modelRegistry">;

  constructor(context: Pick<ExtensionContext, "model" | "modelRegistry">) {
    this.#context = context;
  }

  async evaluate(input: EvaluationInput, signal?: AbortSignal): Promise<EvaluationDecision> {
    if (signal?.aborted) throw new DOMException("Evaluator was aborted", "AbortError");
    const boundedInput = boundedEvaluationInput(input);
    const deterministicFailures = boundedInput.verifierEvidence.filter((evidence) => !evidence.passed);
    if (deterministicFailures.length > 0) return createDeterministicFailureDecision(deterministicFailures);

    const model = this.#context.model;
    if (!model) throw new EvaluatorUnavailableError("No Pi model is selected");

    const auth = await this.#context.modelRegistry.getApiKeyAndHeaders(model);
    if (signal?.aborted) throw new DOMException("Evaluator was aborted", "AbortError");
    if (!auth.ok) {
      throw new EvaluatorUnavailableError(auth.error);
    }

    const serializedInput = JSON.stringify(boundedInput);
    if (Buffer.byteLength(serializedInput, "utf8") > MAX_EVALUATOR_PAYLOAD_BYTES) {
      throw new InvalidEvaluatorResponseError("Evaluator input exceeds the bounded payload limit");
    }
    const userMessage: UserMessage = {
      role: "user",
      content: [{ type: "text", text: serializedInput }],
      timestamp: Date.now(),
    };

    const response = await complete(
      model,
      { systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
      {
        ...(auth.apiKey === undefined ? {} : { apiKey: auth.apiKey }),
        ...(auth.headers === undefined ? {} : { headers: auth.headers }),
        ...(auth.env === undefined ? {} : { env: auth.env }),
        ...(signal === undefined ? {} : { signal }),
      },
    );

    if (response.stopReason === "aborted") throw new DOMException("Evaluator was aborted", "AbortError");
    if (response.stopReason === "error") {
      throw new EvaluatorUnavailableError(response.errorMessage ?? "Evaluator request failed");
    }

    const text = response.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();
    return parseEvaluationDecision(text);
  }
}
