import { describe, expect, it } from "vitest";
import { createCompletionContract } from "../../src/contracts/completion-contract.js";
import { CycleEvidenceCollector, requiredEvidencePassed } from "../../src/evidence/collector.js";

describe("cycle evidence", () => {
  it("matches exact executed bash commands and preserves failure authority", () => {
    const contract = createCompletionContract("tests pass", ["npm test"]);
    const collector = new CycleEvidenceCollector();
    collector.recordToolResult({
      toolCallId: "call-1",
      toolName: "bash",
      input: { command: "npm test" },
      content: [{ type: "text", text: "2 tests failed" }],
      isError: true,
    });

    const evidence = collector.evidenceFor(contract);
    expect(evidence[0]).toEqual(expect.objectContaining({ observed: true, passed: false, toolCallId: "call-1" }));
    expect(requiredEvidencePassed(evidence)).toBe(false);
  });

  it("treats missing required verifier evidence as failure", () => {
    const evidence = new CycleEvidenceCollector().evidenceFor(createCompletionContract("tests pass", ["npm test"]));
    expect(evidence[0]).toEqual(expect.objectContaining({ observed: false, passed: false }));
    expect(requiredEvidencePassed(evidence)).toBe(false);
  });

  it("uses the latest exact execution and bounds stored output", () => {
    const contract = createCompletionContract("tests pass", ["npm test"]);
    const collector = new CycleEvidenceCollector({ maxSummaryBytes: 32 });
    collector.recordToolResult({
      toolCallId: "call-1",
      toolName: "bash",
      input: { command: "npm test" },
      content: [{ type: "text", text: "failed" }],
      isError: true,
    });
    collector.recordToolResult({
      toolCallId: "call-2",
      toolName: "bash",
      input: { command: "npm test" },
      content: [{ type: "text", text: "界".repeat(100) }],
      isError: false,
    });

    const evidence = collector.evidenceFor(contract);
    expect(evidence[0]).toEqual(expect.objectContaining({ passed: true, toolCallId: "call-2" }));
    expect(evidence[0]?.summary).toContain("[truncated by Pi Loops]");
    expect(Buffer.byteLength(evidence[0]?.summary ?? "", "utf8")).toBeLessThanOrEqual(32);
    expect(evidence[0]?.summary).not.toContain("�");
    expect(requiredEvidencePassed(evidence)).toBe(true);
  });
});
