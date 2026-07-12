import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AttendedGoalController, type GoalLoopHost, type GoalResumeRequest, type GoalStartRequest } from "../controller/attended-goal-controller.js";
import { resolveBudget } from "../controller/attended-goal-support.js";
import { isRecoverableRun } from "../controller/state-machine.js";
import { CurrentModelEvaluator } from "../evidence/evaluator.js";
import { ScheduleController, type ScheduleCreateRequest } from "../scheduler/scheduler.js";
import type { ScheduleRecord } from "../shared/types.js";
import { UnattendedRunController, type UnattendedRunHost } from "../controller/unattended-run-controller.js";
import { resolveProjectBinding } from "../contracts/project-binding.js";
import { RunStore } from "../storage/run-store.js";
import type { RunRecord } from "../shared/types.js";
import { NoticeStore } from "../storage/notices.js";
import { resolvePiLoopsDataRoot } from "../storage/paths.js";
import { CHILD_MARKER_ENV, registerWorkerWatchdog } from "../worker/watchdog.js";

const TOOL_ACTIONS = ["goal", "schedule", "status", "stop", "resume"] as const;

export function toolProvenanceMatches(toolPath: string, extensionPath: string): boolean {
  return resolve(toolPath) === resolve(extensionPath);
}

export default function piLoopsExtension(pi: ExtensionAPI): void {
  if (process.env[CHILD_MARKER_ENV]) {
    registerWorkerWatchdog(pi);
    return;
  }

  const controller = new AttendedGoalController();
  const scheduler = new ScheduleController();
  const unattended = new UnattendedRunController();
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

  const scheduledHost = (ctx: ExtensionContext): UnattendedRunHost => ({
    cwd: ctx.cwd,
    ui: {
      hasUI: ctx.hasUI,
      confirm: (title, message) => ctx.ui.confirm(title, message),
      select: (title, options) => ctx.ui.select(title, [...options]),
      input: (title, placeholder) => ctx.ui.input(title, placeholder),
      editor: (title, prefill) => ctx.ui.editor(title, prefill),
      notify: (message, level) => ctx.ui.notify(message, level),
    },
    notify: (message, level) => ctx.ui.notify(message, level),
    appendRunEntry: (run) => pi.appendEntry("pi-loops.run", conciseRunEntry(run)),
  });

  const createSchedule = async (request: ScheduleCreateRequest, ctx: ExtensionContext): Promise<ScheduleRecord> => {
    if (!ctx.hasUI) throw new Error("Schedule creation requires interactive confirmation");
    const preview = scheduler.preview(request.expression);
    const binding = await resolveProjectBinding(ctx.cwd);
    const budget = resolveBudget(request.budget);
    const confirmed = await ctx.ui.confirm(
      "Create Pi Loops schedule?",
      [
        `When: ${preview.normalizedExpression}`,
        `Next occurrence: ${preview.nextFireAt}`,
        `Goal: ${request.goal}`,
        `Project: ${binding.projectRoot}`,
        `Budget: ${budget.maxCycles} cycles / ${Math.round(budget.maxActiveMs / 60_000)} active minutes`,
        "Scheduled work uses an isolated review branch and is never auto-merged.",
      ].join("\n"),
    );
    if (!confirmed) throw new Error("Schedule creation cancelled");
    return scheduler.create({ ...request, parsedExpression: preview }, { cwd: ctx.cwd });
  };

  const scheduleStatus = async (ctx: ExtensionContext): Promise<string> => {
    const schedules = await scheduler.list(ctx.cwd);
    if (schedules.length === 0) return "";
    return ["Schedules:", ...schedules.map(formatScheduleStatus)].join("\n");
  };

  const storedRun = async (ctx: ExtensionContext, runId: string): Promise<RunRecord | undefined> => {
    const binding = await resolveProjectBinding(ctx.cwd);
    return new RunStore(resolvePiLoopsDataRoot(), binding.projectId).load(runId);
  };

  const scheduledResumeCandidate = async (ctx: ExtensionContext, runId?: string): Promise<RunRecord | undefined> => {
    if (runId) {
      const run = await storedRun(ctx, runId);
      return run?.mode === "scheduled" ? run : undefined;
    }
    const binding = await resolveProjectBinding(ctx.cwd);
    const candidates = (await new RunStore(resolvePiLoopsDataRoot(), binding.projectId).list())
      .filter((run) => (run.mode === "goal" || run.mode === "scheduled") && (isRecoverableRun(run) || run.state === "awaiting_user"))
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    if (candidates.length > 1) throw new Error("Specify a run ID to resume");
    return candidates[0]?.mode === "scheduled" ? candidates[0] : undefined;
  };

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
    description: "Control bounded Pi Loops goals and schedules",
    handler: async (args, ctx) => {
      try {
        const parsed = parseCommand(args);
        const commandHost = host(ctx);
        switch (parsed.action) {
          case "goal":
            await recommendSubagentsOnce(ctx);
            await controller.start({ goal: parsed.value }, commandHost);
            break;
          case "schedule": {
            const request = parseScheduleValue(parsed.value);
            const schedule = await createSchedule(request, ctx);
            ctx.ui.notify(`${schedule.scheduleId} created — ${schedule.normalizedExpression}`, "info");
            break;
          }
          case "status": {
            const attended = await controller.status(commandHost);
            const schedules = await scheduleStatus(ctx);
            ctx.ui.notify(schedules ? `${attended}\n${schedules}` : attended, "info");
            break;
          }
          case "stop": {
            const id = parsed.value || undefined;
            const stoppedSchedule = await scheduler.stop(id, ctx.cwd);
            if (!stoppedSchedule) await controller.stop(id, commandHost);
            break;
          }
          case "resume": {
            await recommendSubagentsOnce(ctx);
            const request = parseResumeValue(parsed.value);
            const run = await scheduledResumeCandidate(ctx, request.runId);
            if (run?.scheduleId) {
              await scheduler.resumeOccurrence(run.scheduleId, run.runId, ctx.cwd);
            } else {
              await controller.resume(request, commandHost);
            }
            break;
          }
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
            if (parsed.value.startsWith("schedule_")) {
              await scheduler.delete(parsed.value, ctx.cwd);
            } else {
              const run = await storedRun(ctx, parsed.value);
              if (run?.mode === "scheduled" && run.scheduleId) {
                const schedule = (await scheduler.list(ctx.cwd)).find((item) => item.scheduleId === run.scheduleId);
                if (schedule?.activeRunId === run.runId) throw new Error(`Stop the active scheduled run before deleting it: ${run.runId}`);
              }
              await controller.delete(parsed.value, commandHost);
            }
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
    description: "Start, schedule, inspect, stop, or resume bounded Pi Loops work while Pi is running.",
    promptSnippet: "Control bounded goal loops with independent completion evaluation",
    promptGuidelines: [
      "Use pi_loops goal when the user explicitly asks to keep iterating until a condition is met.",
      "Do not use pi_loops for a normal one-turn task.",
      "Await delegated work and surface verifier results before claiming loop completion.",
    ],
    parameters: Type.Object({
      action: StringEnum(TOOL_ACTIONS, { description: "Goal-loop action" }),
      goal: Type.Optional(Type.String({ description: "Goal condition for action=goal or schedule" })),
      scheduleExpression: Type.Optional(Type.String({ description: "Timing expression for action=schedule" })),
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
        case "schedule": {
          if (!params.goal?.trim() || !params.scheduleExpression?.trim()) {
            throw new Error("pi_loops schedule requires a timing expression and non-empty goal");
          }
          const schedule = await createSchedule({
            expression: params.scheduleExpression,
            goal: params.goal,
            ...(params.verifierCommands === undefined ? {} : { verifierCommands: params.verifierCommands }),
            ...(params.constraints === undefined ? {} : { constraints: params.constraints }),
            ...budgetFromTool(params),
          }, ctx);
          return {
            content: [{ type: "text", text: `${schedule.scheduleId} created — ${schedule.normalizedExpression}` }],
            details: { scheduleId: schedule.scheduleId, nextFireAt: schedule.nextFireAt },
            terminate: true,
          };
        }
        case "status": {
          const attended = await controller.status(toolHost);
          const schedules = await scheduleStatus(ctx);
          return {
            content: [{ type: "text", text: schedules ? `${attended}\n${schedules}` : attended }],
            details: { activeRunId: controller.activeRunId },
          };
        }
        case "stop": {
          const stoppedSchedule = await scheduler.stop(params.runId, ctx.cwd);
          if (stoppedSchedule) return { content: [{ type: "text", text: `${stoppedSchedule} stopped` }], details: { scheduleId: stoppedSchedule }, terminate: true };
          const stopped = await controller.stop(params.runId, toolHost);
          return toolResult(stopped ? `${stopped.runId} cancelled` : "No goal loop is active", stopped);
        }
        case "resume": {
          await recommendSubagentsOnce(ctx);
          const request: GoalResumeRequest = {
            ...(params.runId === undefined ? {} : { runId: params.runId }),
            ...(params.guidance === undefined ? {} : { guidance: params.guidance }),
            ...budgetFromTool(params),
          };
          const stored = await scheduledResumeCandidate(ctx, request.runId);
          if (stored?.scheduleId) {
            await scheduler.resumeOccurrence(stored.scheduleId, stored.runId, ctx.cwd);
            return toolResult(`${stored.runId} scheduled restart requested`, stored);
          }
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
    try {
      await scheduler.start({ cwd: ctx.cwd, notify: (message, level) => ctx.ui.notify(message, level) },
        (schedule, runId, signal, kind) => unattended.runSchedule(
          schedule,
          runId,
          new CurrentModelEvaluator(ctx),
          scheduledHost(ctx),
          signal,
          kind,
        ));
    } catch (error) {
      ctx.ui.notify(`Pi Loops scheduler startup failed: ${error instanceof Error ? error.message : String(error)}`, "error");
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
    await scheduler.shutdown();
    await unattended.shutdown();
    await controller.interrupt(host(ctx));
  });
}

function parseCommand(args: string): { action: "goal" | "schedule" | "status" | "stop" | "resume" | "clean" | "delete" | "help" | "unsupported"; value: string } {
  const trimmed = args.trim();
  if (!trimmed) return { action: "status", value: "" };
  const separator = trimmed.search(/\s/);
  const action = (separator === -1 ? trimmed : trimmed.slice(0, separator)).toLowerCase();
  const value = separator === -1 ? "" : trimmed.slice(separator + 1).trim();
  if (action === "goal" || action === "schedule" || action === "status" || action === "stop" || action === "resume" || action === "clean" || action === "delete" || action === "help") {
    if (action === "goal" && !value) throw new Error("Usage: /loops goal <goal>");
    if (action === "schedule" && !value) throw new Error("Usage: /loops schedule <time-expression> -- <goal>");
    return { action, value };
  }
  return { action: "unsupported", value: action };
}

function parseScheduleValue(value: string): ScheduleCreateRequest {
  const separator = value.indexOf(" -- ");
  if (separator <= 0) throw new Error("Usage: /loops schedule <time-expression> -- <goal>");
  const expression = value.slice(0, separator).trim();
  const goal = value.slice(separator + 4).trim();
  if (!expression || !goal) throw new Error("Usage: /loops schedule <time-expression> -- <goal>");
  return { expression, goal };
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

function formatScheduleStatus(schedule: ScheduleRecord): string {
  const pause = schedule.pauseReason ? `/${schedule.pauseReason}` : "";
  const next = schedule.nextFireAt ? ` next ${schedule.nextFireAt}` : "";
  const active = schedule.activeRunId ? ` active ${schedule.activeRunId}` : "";
  return `${schedule.scheduleId}  ${schedule.state}${pause}  ${schedule.normalizedExpression}${next}${active} — ${schedule.goal}`;
}

function commandHelp(): string {
  return [
    "/loops goal <goal>",
    "/loops schedule <time-expression> -- <goal>",
    "/loops status",
    "/loops stop [run-id]",
    "/loops resume [run-id] [guidance]",
    "/loops clean",
    "/loops delete <run-id|schedule-id>",
  ].join("\n");
}
