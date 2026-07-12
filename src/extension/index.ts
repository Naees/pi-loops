import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AttendedGoalController, type GoalLoopHost, type GoalResumeRequest, type GoalStartRequest } from "../controller/attended-goal-controller.js";
import { CurrentModelEvaluator } from "../evidence/evaluator.js";
import type { RunRecord } from "../shared/types.js";
import { NoticeStore } from "../storage/notices.js";
import { resolvePiLoopsDataRoot } from "../storage/paths.js";
import { CHILD_MARKER_ENV, registerWorkerWatchdog } from "../worker/watchdog.js";

const TOOL_ACTIONS = ["goal", "status", "stop", "resume"] as const;

export function toolProvenanceMatches(toolPath: string, extensionPath: string): boolean {
  return resolve(toolPath) === resolve(extensionPath);
}

export default function piLoopsExtension(pi: ExtensionAPI): void {
  if (process.env[CHILD_MARKER_ENV]) {
    registerWorkerWatchdog(pi);
    return;
  }

  const controller = new AttendedGoalController();
  const ownExtensionPath = resolve(fileURLToPath(import.meta.url));
  const noticeStore = new NoticeStore(resolvePiLoopsDataRoot());
  let subagentNoticeShownThisProcess = false;

  const host = (ctx: ExtensionContext): GoalLoopHost => ({
    cwd: ctx.cwd,
    isIdle: ctx.isIdle(),
    sendWork(message, delivery) {
      if (delivery === "followUp") pi.sendUserMessage(message, { deliverAs: "followUp" });
      else pi.sendUserMessage(message);
    },
    notify(message, level) {
      ctx.ui.notify(message, level);
    },
    appendRunEntry(run) {
      pi.appendEntry("pi-loops.run", conciseRunEntry(run));
    },
    abortAgent() {
      ctx.abort();
    },
    async selectRun(runs) {
      if (!ctx.hasUI) return undefined;
      const labels = runs.map((run) => `${run.runId}  ${run.state}  ${run.goal}`);
      const selected = await ctx.ui.select("Resume which Pi Loops run?", labels);
      return selected?.split(/\s+/, 1)[0];
    },
  });

  const recommendSubagentsOnce = async (ctx: ExtensionContext): Promise<void> => {
    if (subagentNoticeShownThisProcess || pi.getAllTools().some((tool) => tool.name === "subagent")) return;
    subagentNoticeShownThisProcess = true;
    try {
      if (!(await noticeStore.shouldShowSubagentsRecommendation())) return;
      ctx.ui.notify(
        "Pi Loops works without additional packages. For parallel workers and independent reviews, pi-subagents is recommended: pi install npm:pi-subagents",
        "info",
      );
      await noticeStore.markSubagentsRecommendationShown();
    } catch (error) {
      ctx.ui.notify(`Could not persist the Pi Loops recommendation dismissal: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  };

  pi.registerCommand("loops", {
    description: "Control bounded Pi Loops goal workflows",
    handler: async (args, ctx) => {
      try {
        const parsed = parseCommand(args);
        const commandHost = host(ctx);
        switch (parsed.action) {
          case "goal":
            await recommendSubagentsOnce(ctx);
            await controller.start({ goal: parsed.value }, commandHost);
            break;
          case "status":
            ctx.ui.notify(await controller.status(commandHost), "info");
            break;
          case "stop":
            await controller.stop(parsed.value || undefined, commandHost);
            break;
          case "resume":
            await recommendSubagentsOnce(ctx);
            await controller.resume(parseResumeValue(parsed.value), commandHost);
            break;
          case "clean": {
            const evicted = await controller.clean(commandHost);
            ctx.ui.notify(evicted.length === 0 ? "No terminal run records were eligible for cleanup." : `Deleted ${evicted.length} run record(s): ${evicted.join(", ")}`, "info");
            break;
          }
          case "delete": {
            if (!parsed.value) throw new Error("Usage: /loops delete <run-id>");
            if (!ctx.hasUI) throw new Error("Run deletion requires an interactive confirmation");
            const confirmed = await ctx.ui.confirm("Delete Pi Loops run?", `Permanently delete runtime data for ${parsed.value}?`);
            if (!confirmed) {
              ctx.ui.notify("Run deletion cancelled.", "info");
              break;
            }
            await controller.delete(parsed.value, commandHost);
            ctx.ui.notify(`Deleted Pi Loops runtime data for ${parsed.value}.`, "info");
            break;
          }
          case "help":
            ctx.ui.notify(commandHelp(), "info");
            break;
          case "unsupported":
            ctx.ui.notify(`Pi Loops subcommand is planned for a later phase: ${parsed.value}`, "warning");
            break;
        }
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerTool({
    name: "pi_loops",
    label: "Pi Loops",
    description: "Start, inspect, stop, or resume a bounded attended goal loop while Pi is running.",
    promptSnippet: "Control bounded goal loops with independent completion evaluation",
    promptGuidelines: [
      "Use pi_loops goal when the user explicitly asks to keep iterating until a condition is met.",
      "Do not use pi_loops for a normal one-turn task.",
      "Await delegated work and surface verifier results before claiming loop completion.",
    ],
    parameters: Type.Object({
      action: StringEnum(TOOL_ACTIONS, { description: "Goal-loop action" }),
      goal: Type.Optional(Type.String({ description: "Goal condition for action=goal" })),
      verifierCommands: Type.Optional(Type.Array(Type.String(), { description: "Required commands that must succeed" })),
      constraints: Type.Optional(Type.Array(Type.String(), { description: "Constraints that must remain true" })),
      runId: Type.Optional(Type.String({ description: "Target run ID for stop/resume" })),
      guidance: Type.Optional(Type.String({ description: "New guidance when resuming" })),
      maxCycles: Type.Optional(Type.Integer({ minimum: 1, description: "Finite outer-cycle limit" })),
      maxActiveMinutes: Type.Optional(Type.Integer({ minimum: 1, description: "Finite active-time limit in minutes" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const toolHost = host(ctx);
      switch (params.action) {
        case "goal": {
          if (!params.goal?.trim()) throw new Error("pi_loops goal requires a non-empty goal");
          await recommendSubagentsOnce(ctx);
          const request: GoalStartRequest = {
            goal: params.goal,
            ...(params.verifierCommands === undefined ? {} : { verifierCommands: params.verifierCommands }),
            ...(params.constraints === undefined ? {} : { constraints: params.constraints }),
            ...budgetFromTool(params),
          };
          const run = await controller.start(request, toolHost);
          return toolResult(`${run.runId} started`, run);
        }
        case "status":
          return {
            content: [{ type: "text", text: await controller.status(toolHost) }],
            details: { activeRunId: controller.activeRunId },
          };
        case "stop": {
          const stopped = await controller.stop(params.runId, toolHost);
          return toolResult(stopped ? `${stopped.runId} cancelled` : "No attended goal loop is active", stopped);
        }
        case "resume": {
          await recommendSubagentsOnce(ctx);
          const request: GoalResumeRequest = {
            ...(params.runId === undefined ? {} : { runId: params.runId }),
            ...(params.guidance === undefined ? {} : { guidance: params.guidance }),
            ...budgetFromTool(params),
          };
          const run = await controller.resume(request, toolHost);
          return toolResult(`${run.runId} resumed`, run);
        }
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const effectiveTool = pi.getAllTools().find((tool) => tool.name === "pi_loops");
    if (!effectiveTool) {
      ctx.ui.notify("Pi Loops tool registration is unavailable in this session.", "error");
    } else if (!toolProvenanceMatches(effectiveTool.sourceInfo.path, ownExtensionPath)) {
      ctx.ui.notify(
        `Pi Loops tool collision: effective pi_loops provenance is ${effectiveTool.sourceInfo.source} (${effectiveTool.sourceInfo.path}), not this package.`,
        "error",
      );
    }
    const loopCommands = pi.getCommands().filter((command) => command.name === "loops" || /^loops:\d+$/.test(command.name));
    if (loopCommands.length > 1) {
      ctx.ui.notify(
        `Pi Loops command collision detected. Available command names: ${loopCommands.map((command) => `/${command.name}`).join(", ")}`,
        "warning",
      );
    }
    try {
      for (const run of await controller.reconcile(ctx.cwd)) {
        pi.appendEntry("pi-loops.run", conciseRunEntry(run));
        ctx.ui.notify(`${run.runId}: interrupted — recovered stale active state after startup`, "warning");
      }
    } catch (error) {
      ctx.ui.notify(`Pi Loops startup reconciliation failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  });

  pi.on("tool_result", async (event) => {
    controller.recordToolResult({
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: event.input,
      content: event.content,
      isError: event.isError,
    });
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!controller.activeRunId) return;
    await controller.settle(lastAssistantText(ctx), new CurrentModelEvaluator(ctx), host(ctx));
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await controller.interrupt(host(ctx));
  });
}

function parseCommand(args: string): { action: "goal" | "status" | "stop" | "resume" | "clean" | "delete" | "help" | "unsupported"; value: string } {
  const trimmed = args.trim();
  if (!trimmed) return { action: "status", value: "" };
  const separator = trimmed.search(/\s/);
  const action = (separator === -1 ? trimmed : trimmed.slice(0, separator)).toLowerCase();
  const value = separator === -1 ? "" : trimmed.slice(separator + 1).trim();
  if (action === "goal" || action === "status" || action === "stop" || action === "resume" || action === "clean" || action === "delete" || action === "help") {
    if (action === "goal" && !value) throw new Error("Usage: /loops goal <goal>");
    return { action, value };
  }
  return { action: "unsupported", value: action };
}

function parseResumeValue(value: string): GoalResumeRequest {
  if (!value) return {};
  const [first, ...rest] = value.split(/\s+/);
  if (first?.startsWith("run_")) {
    return { runId: first, ...(rest.length === 0 ? {} : { guidance: rest.join(" ") }) };
  }
  return { guidance: value };
}

function budgetFromTool(params: { maxCycles?: number; maxActiveMinutes?: number }): { budget?: Partial<RunRecord["budget"]> } {
  const budget = {
    ...(params.maxCycles === undefined ? {} : { maxCycles: params.maxCycles }),
    ...(params.maxActiveMinutes === undefined ? {} : { maxActiveMs: params.maxActiveMinutes * 60_000 }),
  };
  return Object.keys(budget).length === 0 ? {} : { budget };
}

function conciseRunEntry(run: RunRecord): Record<string, unknown> {
  return {
    schemaVersion: 1,
    runId: run.runId,
    state: run.state,
    cycle: run.cycle,
    totalCycles: run.totalCycles ?? run.cycle,
    updatedAt: run.updatedAt,
  };
}

function lastAssistantText(ctx: ExtensionContext): string {
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

function toolResult(text: string, run: RunRecord | undefined) {
  return {
    content: [{ type: "text" as const, text }],
    details: run ? conciseRunEntry(run) : {},
    terminate: true,
  };
}

function commandHelp(): string {
  return [
    "/loops goal <goal>",
    "/loops status",
    "/loops stop [run-id]",
    "/loops resume [run-id] [guidance]",
    "/loops clean",
    "/loops delete <run-id>",
    "Scheduling and proactive triggers arrive in later phases.",
  ].join("\n");
}
