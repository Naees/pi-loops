import { isRecord } from "../shared/validation.js";
import { CycleEvidenceCollector } from "./collector.js";

export function recordRpcToolEvidence(collector: CycleEvidenceCollector, event: unknown): void {
  if (!isRecord(event) || event.type !== "tool_execution_end" || event.toolName !== "bash" || typeof event.toolCallId !== "string") return;
  const args = typeof event.args === "object" && event.args !== null ? event.args as Record<string, unknown> : {};
  const result = typeof event.result === "object" && event.result !== null ? event.result as Record<string, unknown> : {};
  const content = Array.isArray(result.content)
    ? result.content.filter((item): item is { type: string; text?: string } =>
      typeof item === "object" && item !== null && typeof (item as Record<string, unknown>).type === "string")
    : [];

  collector.recordToolResult({
    toolCallId: event.toolCallId,
    toolName: "bash",
    input: args,
    content: content.map((item) => item.type === "text" && typeof item.text === "string"
      ? { type: "text", text: item.text }
      : { type: item.type }),
    isError: event.isError === true,
  });
}
