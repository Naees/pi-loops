import { complete, type UserMessage } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

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

const SYSTEM_PROMPT = `You are an independent completion evaluator for a bounded coding loop.
Judge only whether the declared goal and constraints are satisfied by the supplied evidence.
Required deterministic verifier failures or missing evidence can never be overridden.
Return exactly one JSON object with this shape:
{"complete":boolean,"needsUser":boolean,"reason":string,"failedCriteria":string[],"feedback":string|null}
Do not include markdown, commentary, or tool calls.`;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function parseEvaluationDecision(text: string): EvaluationDecision {
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
    !isStringArray(record.failedCriteria) ||
    !(typeof record.feedback === "string" || record.feedback === null)
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
    const deterministicFailures = input.verifierEvidence.filter((evidence) => !evidence.passed);
    if (deterministicFailures.length > 0) {
      return {
        complete: false,
        needsUser: false,
        reason: "Required deterministic verification is failing or missing.",
        failedCriteria: deterministicFailures.map((evidence) => evidence.criterion),
        feedback: deterministicFailures.map((evidence) => `${evidence.criterion}: ${evidence.summary}`).join("\n"),
      };
    }

    const model = this.#context.model;
    if (!model) throw new EvaluatorUnavailableError("No Pi model is selected");

    const auth = await this.#context.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) {
      throw new EvaluatorUnavailableError(auth.ok ? `No API key is available for ${model.provider}` : auth.error);
    }

    const userMessage: UserMessage = {
      role: "user",
      content: [{ type: "text", text: JSON.stringify(input) }],
      timestamp: Date.now(),
    };
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
