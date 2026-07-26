import { beforeEach, describe, expect, it, vi } from "vitest";

const completeMock = vi.hoisted(() => vi.fn());
vi.mock("@earendil-works/pi-ai/compat", () => ({ complete: completeMock }));

import { CurrentModelEvaluator } from "../../src/evidence/evaluator.js";

const input = {
  goal: "finish",
  constraints: ["preserve behavior"],
  workerSummary: "implemented",
  verifierEvidence: [{ criterion: "tests", passed: true, summary: "passed" }],
};

function evaluator(auth: Record<string, unknown>) {
  return new CurrentModelEvaluator({
    model: { provider: "test-provider", id: "test-model" } as never,
    modelRegistry: { getApiKeyAndHeaders: vi.fn(async () => auth) } as never,
  });
}

describe("current model evaluator provider adapter", () => {
  beforeEach(() => completeMock.mockReset());

  it("forwards authentication context and signal and parses concatenated text blocks", async () => {
    completeMock.mockResolvedValue({
      stopReason: "stop",
      content: [
        { type: "text", text: '{"complete":true,"needsUser":false,' },
        { type: "toolCall", name: "ignored" },
        { type: "text", text: '"reason":"accepted","failedCriteria":[],"feedback":null}' },
      ],
    });
    const signal = new AbortController().signal;

    await expect(evaluator({ ok: true, apiKey: "secret", headers: { "x-test": "yes" }, env: { TEST: "1" } }).evaluate(input, signal))
      .resolves.toEqual({ complete: true, needsUser: false, reason: "accepted", failedCriteria: [], feedback: null });

    expect(completeMock).toHaveBeenCalledOnce();
    expect(completeMock.mock.calls[0]?.[2]).toEqual({
      apiKey: "secret",
      headers: { "x-test": "yes" },
      env: { TEST: "1" },
      signal,
    });
  });

  it.each([
    [{ ok: true, headers: { Authorization: "Bearer header-token" } }, { headers: { Authorization: "Bearer header-token" } }],
    [{ ok: true, env: { AWS_PROFILE: "test-profile" } }, { env: { AWS_PROFILE: "test-profile" } }],
    [{ ok: true }, {}],
  ])("supports provider authentication without an API key", async (auth, expectedOptions) => {
    completeMock.mockResolvedValue({
      stopReason: "stop",
      content: [{ type: "text", text: '{"complete":true,"needsUser":false,"reason":"accepted","failedCriteria":[],"feedback":null}' }],
    });

    await expect(evaluator(auth).evaluate(input)).resolves.toEqual({
      complete: true,
      needsUser: false,
      reason: "accepted",
      failedCriteria: [],
      feedback: null,
    });
    expect(completeMock.mock.calls[0]?.[2]).toEqual(expectedOptions);
  });

  it("fails before provider invocation when authentication resolution fails", async () => {
    await expect(evaluator({ ok: false, error: "authentication failed" }).evaluate(input)).rejects.toThrow("authentication failed");
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("maps provider aborts and errors to typed failures", async () => {
    const current = evaluator({ ok: true, apiKey: "secret" });
    completeMock.mockResolvedValueOnce({ stopReason: "aborted", content: [] });
    await expect(current.evaluate(input)).rejects.toMatchObject({ name: "AbortError" });

    completeMock.mockResolvedValueOnce({ stopReason: "error", errorMessage: "provider down", content: [] });
    await expect(current.evaluate(input)).rejects.toMatchObject({ name: "EvaluatorUnavailableError", message: "provider down" });
  });

  it("rejects aggregate evaluator payloads above the transport ceiling", async () => {
    await expect(evaluator({ ok: true, apiKey: "secret" }).evaluate({
      goal: "finish",
      constraints: Array.from({ length: 50 }, () => "c".repeat(4 * 1024)),
      workerSummary: "summary",
      verifierEvidence: Array.from({ length: 20 }, () => ({
        criterion: "v".repeat(4 * 1024),
        passed: true,
        summary: "s".repeat(8 * 1024),
      })),
    })).rejects.toMatchObject({ name: "InvalidEvaluatorResponseError", message: "Evaluator input exceeds the bounded payload limit" });
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("lets cancellation win before and during authentication resolution", async () => {
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    const getApiKeyAndHeaders = vi.fn(async () => ({ ok: true, apiKey: "secret" }));
    const current = new CurrentModelEvaluator({
      model: { provider: "test-provider", id: "test-model" } as never,
      modelRegistry: { getApiKeyAndHeaders } as never,
    });
    await expect(current.evaluate(input, alreadyAborted.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(getApiKeyAndHeaders).not.toHaveBeenCalled();

    let resolveAuth: ((value: { ok: true; apiKey: string }) => void) | undefined;
    const delayedAuth = vi.fn(() => new Promise<{ ok: true; apiKey: string }>((resolve) => { resolveAuth = resolve; }));
    const delayed = new CurrentModelEvaluator({
      model: { provider: "test-provider", id: "test-model" } as never,
      modelRegistry: { getApiKeyAndHeaders: delayedAuth } as never,
    });
    const abort = new AbortController();
    const evaluation = delayed.evaluate(input, abort.signal);
    await vi.waitFor(() => expect(delayedAuth).toHaveBeenCalledOnce());
    abort.abort();
    resolveAuth?.({ ok: true, apiKey: "secret" });
    await expect(evaluation).rejects.toMatchObject({ name: "AbortError" });
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("bounds multibyte evaluator input before sending it", async () => {
    completeMock.mockResolvedValue({
      stopReason: "stop",
      content: [{ type: "text", text: '{"complete":true,"needsUser":false,"reason":"accepted","failedCriteria":[],"feedback":null}' }],
    });
    await evaluator({ ok: true, apiKey: "secret" }).evaluate({
      ...input,
      goal: "界".repeat(20_000),
      workerSummary: "界".repeat(20_000),
    });

    const request = completeMock.mock.calls[0]?.[1] as { messages: { content: { text: string }[] }[] };
    const bounded = JSON.parse(request.messages[0]?.content[0]?.text ?? "{}") as { goal: string; workerSummary: string };
    expect(Buffer.byteLength(bounded.goal, "utf8")).toBeLessThanOrEqual(32 * 1024);
    expect(Buffer.byteLength(bounded.workerSummary, "utf8")).toBeLessThanOrEqual(32 * 1024);
  });
});
