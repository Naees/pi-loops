import { complete, type UserMessage } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateUtf8 } from "../shared/text.js";
import { isStringArray } from "../shared/validation.js";

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

export interface EvaluationDecision {
  readonly complete: boolean;
  readonly needsUser: boolean;
  readonly reason: string;
  readonly failedCriteria: readonly string[];
  readonly feedback: string | null;
}

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
    constraints: input.constraints.slice(0, 50).map((constraint) => truncateUtf8(constraint, 4 * 1024)),
    workerSummary: truncateUtf8(input.workerSummary, MAX_EVALUATOR_TEXT_BYTES),
    verifierEvidence: input.verifierEvidence.slice(0, 20).map((evidence) => ({
      criterion: truncateUtf8(evidence.criterion, 4 * 1024),
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
    throw new InvalidEvaluatorResponseError(`Evaluator returned invalid JSON: ${(error as Error).message}`);
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidEvaluatorResponseError("Evaluator response must be an object");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(["complete", "needsUser", "reason", "failedCriteria", "feedback"]);
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new InvalidEvaluatorResponseError(`Unknown evaluator field(s): ${unknown.join(", ")}`);
  if (
    typeof record.complete !== "boolean" ||
    typeof record.needsUser !== "boolean" ||
    typeof record.reason !== "string" ||
    record.reason.trim().length === 0 ||
    Buffer.byteLength(record.reason, "utf8") > 8 * 1024 ||
    !isStringArray(record.failedCriteria) ||
    record.failedCriteria.length > 50 ||
    record.failedCriteria.some((criterion) => Buffer.byteLength(criterion, "utf8") > 4 * 1024) ||
    !(typeof record.feedback === "string" || record.feedback === null) ||
    (typeof record.feedback === "string" && Buffer.byteLength(record.feedback, "utf8") > 16 * 1024)
  ) {
    throw new InvalidEvaluatorResponseError("Evaluator response has an invalid shape");
  }
  if (record.complete && record.needsUser) {
    throw new InvalidEvaluatorResponseError("A completed evaluation cannot also require the user");
  }
  if (record.complete && record.failedCriteria.length > 0) {
    throw new InvalidEvaluatorResponseError("A completed evaluation cannot contain failed criteria");
  }

  return {
    complete: record.complete,
    needsUser: record.needsUser,
    reason: record.reason,
    failedCriteria: record.failedCriteria,
    feedback: record.feedback,
  };
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
    if (!auth.ok || !auth.apiKey) {
      throw new EvaluatorUnavailableError(auth.ok ? `No API key is available for ${model.provider}` : auth.error);
    }

    const userMessage: UserMessage = {
      role: "user",
      content: [{ type: "text", text: JSON.stringify(boundedInput) }],
      timestamp: Date.now(),
    };
    if (Buffer.byteLength(JSON.stringify(boundedInput), "utf8") > MAX_EVALUATOR_PAYLOAD_BYTES) {
      throw new InvalidEvaluatorResponseError("Evaluator input exceeds the bounded payload limit");
    }

    const response = await complete(
      model,
      { systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
      {
        apiKey: auth.apiKey,
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
