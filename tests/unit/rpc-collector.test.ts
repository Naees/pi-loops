import { describe, expect, it } from "vitest";
import { createCompletionContract } from "../../src/contracts/completion-contract.js";
import { CycleEvidenceCollector } from "../../src/evidence/collector.js";
import { recordRpcToolEvidence } from "../../src/evidence/rpc-collector.js";

describe("RPC evidence collector adapter", () => {
  it("records bounded bash tool results used by deterministic verifiers", () => {
    const collector = new CycleEvidenceCollector();
    recordRpcToolEvidence(collector, {
      type: "tool_execution_end",
      toolName: "bash",
      toolCallId: "call-1",
      args: { command: "npm test" },
      result: { content: [{ type: "text", text: "passed" }, { type: "image", data: "ignored" }] },
      isError: false,
    });

    expect(collector.evidenceFor(createCompletionContract("verify", ["npm test"], []))).toEqual([
      expect.objectContaining({
        command: "npm test",
        observed: true,
        passed: true,
        summary: "passed",
        toolCallId: "call-1",
      }),
    ]);
  });

  it.each([
    null,
    [],
    { type: "tool_execution_end", toolName: "read", toolCallId: "call-1" },
    { type: "tool_execution_end", toolName: "bash" },
  ])("ignores unrelated or malformed envelopes without throwing", (event) => {
    const collector = new CycleEvidenceCollector();
    recordRpcToolEvidence(collector, event as unknown as Record<string, unknown>);
    expect(collector.evidenceFor(createCompletionContract("verify", ["npm test"], []))[0]).toEqual(
      expect.objectContaining({ observed: false, passed: false }),
    );
  });

  it("treats malformed args and result content as empty and preserves error status", () => {
    const collector = new CycleEvidenceCollector();
    recordRpcToolEvidence(collector, {
      type: "tool_execution_end",
      toolName: "bash",
      toolCallId: "call-2",
      args: "invalid",
      result: { content: [null, "invalid", { text: "missing type" }] },
      isError: true,
    });

    expect(collector.evidenceFor(createCompletionContract("verify", ["npm test"], []))[0]).toEqual(
      expect.objectContaining({ observed: false, passed: false }),
    );
  });
});
