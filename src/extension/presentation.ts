import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RunRecord, ScheduleRecord, TriggerRecord } from "../shared/types.js";

export function conciseRunEntry(run: RunRecord): Record<string, unknown> {
  return {
    schemaVersion: 1,
    runId: run.runId,
    state: run.state,
    cycle: run.cycle,
    totalCycles: run.totalCycles ?? run.cycle,
    updatedAt: run.updatedAt,
  };
}

export function lastAssistantText(ctx: Pick<ExtensionContext, "sessionManager">): string {
  for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const text = entry.message.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "The worker did not surface an assistant summary in this cycle.";
}

export function toolResult(text: string, run: RunRecord | undefined) {
  return {
    content: [{ type: "text" as const, text }],
    details: run ? conciseRunEntry(run) : {},
    terminate: true,
  };
}

export function formatScheduleStatus(schedule: ScheduleRecord): string {
  const pause = schedule.pauseReason ? `/${schedule.pauseReason}` : "";
  const next = schedule.nextFireAt ? ` next ${schedule.nextFireAt}` : "";
  const active = schedule.activeRunId ? ` active ${schedule.activeRunId}` : "";
  return `${schedule.scheduleId}  ${schedule.state}${pause}  ${schedule.normalizedExpression}${next}${active} — ${schedule.goal}`;
}

export function formatTriggerStatus(trigger: TriggerRecord): string {
  const source = trigger.source.kind === "event" ? "event" : `watch ${trigger.source.relativePath}`;
  const active = trigger.activeRunId ? ` active ${trigger.activeRunId}` : "";
  return `${trigger.triggerId}  ${trigger.state}  ${source}${active} — ${trigger.goal}`;
}

export function commandHelp(): string {
  return [
    "/loops goal <goal>",
    "/loops schedule <time-expression> -- <goal>",
    "/loops watch <project-path|event> -- <goal>",
    "/loops status",
    "/loops stop [run-id|schedule-id|trigger-id]",
    "/loops resume [run-id|schedule-id|trigger-id] [guidance]",
    "/loops clean",
    "/loops delete <run-id|schedule-id|trigger-id>",
  ].join("\n");
}
