import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AttendedGoalController, type GoalLoopHost, type GoalResumeRequest, type GoalStartRequest } from "../controller/attended-goal-controller.js";
import { resolveBudget } from "../controller/attended-goal-support.js";
import { isResumableRun } from "../controller/state-machine.js";
import { CurrentModelEvaluator } from "../evidence/evaluator.js";
import { ScheduleController, type ScheduleCreateRequest } from "../scheduler/scheduler.js";
import type { RunRecord, ScheduleRecord } from "../shared/types.js";
import { UnattendedRunController } from "../controller/unattended-run-controller.js";
import { resolveProjectBinding } from "../contracts/project-binding.js";
import { RunStore } from "../storage/run-store.js";
import { NoticeStore } from "../storage/notices.js";
import { resolvePiLoopsDataRoot } from "../storage/paths.js";
import { CHILD_MARKER_ENV, registerWorkerWatchdog } from "../worker/watchdog.js";
import { TriggerController, type TriggerCreateRequest } from "../triggers/controller.js";
import { TRIGGER_EVENT_NAME } from "../triggers/event-bus.js";
import { resolveFilesystemTarget } from "../triggers/filesystem.js";
import { errorMessage } from "../shared/errors.js";
import { budgetFromTool, parseCommand, parseResumeValue, parseScheduleValue, parseWatchValue } from "./commands.js";
import { createGoalHost, createUnattendedHost } from "./hosts.js";
import { commandHelp, conciseRunEntry, formatScheduleStatus, formatTriggerStatus, lastAssistantText, toolResult } from "./presentation.js";
import { routeStopWork, shutdownUnattendedControllers } from "./routing.js";
import { registerTriggerEventRelay } from "./trigger-events.js";

export { routeStopWork, shutdownUnattendedControllers } from "./routing.js";

const TOOL_ACTIONS = ["goal", "schedule", "trigger", "status", "stop", "resume"] as const;

export function toolProvenanceMatches(toolPath: string, extensionPath: string): boolean {
  return resolve(toolPath) === resolve(extensionPath);
}

export default function piLoopsExtension(pi: ExtensionAPI): void {
  if (process.env[CHILD_MARKER_ENV]) {
    registerWorkerWatchdog(pi);
    return;
  }

  const dataRoot = resolvePiLoopsDataRoot();
  const goals = new AttendedGoalController({ dataRoot });
  const scheduler = new ScheduleController({ dataRoot });
  const triggers = new TriggerController({ dataRoot });
  const unattended = new UnattendedRunController({ dataRoot });
  const ownExtensionPath = resolve(fileURLToPath(import.meta.url));
  const noticeStore = new NoticeStore(dataRoot);
  const triggerEvents = registerTriggerEventRelay(pi, triggers);
  let subagentNoticeShownThisProcess = false;

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

  const createTrigger = async (request: TriggerCreateRequest, ctx: ExtensionContext) => {
    if (!ctx.hasUI) throw new Error("Trigger creation requires interactive confirmation");
    const binding = await resolveProjectBinding(ctx.cwd);
    const filesystemTarget = request.source.kind === "filesystem"
      ? await resolveFilesystemTarget(binding.projectRoot, request.source.path)
      : undefined;
    const source = filesystemTarget
      ? `filesystem: ${filesystemTarget.absolutePath}`
      : `event bus: ${TRIGGER_EVENT_NAME}`;
    const budget = resolveBudget(request.budget);
    const confirmed = await ctx.ui.confirm(
      "Create Pi Loops trigger?",
      [
        `Source: ${source}`,
        `Goal: ${request.goal}`,
        `Project: ${binding.projectRoot}`,
        `Budget: ${budget.maxCycles} cycles / ${Math.round(budget.maxActiveMs / 60_000)} active minutes`,
        "Triggered work uses an isolated review branch and is never auto-merged.",
      ].join("\n"),
    );
    if (!confirmed) throw new Error("Trigger creation cancelled");
    return triggers.create(
      filesystemTarget
        ? { ...request, source: { ...request.source, kind: "filesystem", path: filesystemTarget.absolutePath } }
        : request,
      { cwd: ctx.cwd },
    );
  };

  const scheduleStatus = async (ctx: ExtensionContext): Promise<string> => {
    const schedules = await scheduler.list(ctx.cwd);
    if (schedules.length === 0) return "";
    return ["Schedules:", ...schedules.map(formatScheduleStatus)].join("\n");
  };

  const triggerStatus = async (ctx: ExtensionContext): Promise<string> => {
    const records = await triggers.list(ctx.cwd);
    if (records.length === 0) return "";
    return ["Triggers:", ...records.map(formatTriggerStatus)].join("\n");
  };

  const storedRun = async (ctx: ExtensionContext, runId: string): Promise<RunRecord | undefined> => {
    const binding = await resolveProjectBinding(ctx.cwd);
    return new RunStore(dataRoot, binding.projectId).load(runId);
  };

  const unattendedResumeCandidate = async (ctx: ExtensionContext, runId?: string): Promise<RunRecord | undefined> => {
    if (runId) {
      const run = await storedRun(ctx, runId);
      return run?.mode === "scheduled" || run?.mode === "proactive" ? run : undefined;
    }
    const binding = await resolveProjectBinding(ctx.cwd);
    const candidates = (await new RunStore(dataRoot, binding.projectId).list())
      .filter((run) => (run.mode === "goal" || run.mode === "scheduled" || run.mode === "proactive") && isResumableRun(run))
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    if (candidates.length > 1) throw new Error("Specify a run ID to resume");
    return candidates[0]?.mode === "goal" ? undefined : candidates[0];
  };

  const combinedStatus = async (ctx: ExtensionContext, goalHost: GoalLoopHost): Promise<string> => {
    const attended = await goals.status(goalHost);
    const schedules = await scheduleStatus(ctx);
    const proactive = await triggerStatus(ctx);
    return [attended, schedules, proactive].filter(Boolean).join("\n");
  };

  const stopWork = (runId: string | undefined, ctx: ExtensionContext, goalHost: GoalLoopHost) => routeStopWork({
    requestedId: runId,
    activeRunId: unattended.activeRunId,
    loadRun: (id) => storedRun(ctx, id),
    stopSchedule: (id) => scheduler.stop(id, ctx.cwd),
    stopTrigger: (id) => triggers.stop(id, ctx.cwd),
    stopGoal: (id) => goals.stop(id, goalHost),
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
      ctx.ui.notify(`Could not persist the Pi Loops recommendation dismissal: ${errorMessage(error)}`, "warning");
    }
  };

  const resumeWork = async (request: GoalResumeRequest, ctx: ExtensionContext, goalHost: GoalLoopHost) => {
    if (request.runId?.startsWith("trigger_")) {
      if (request.guidance || request.budget) throw new Error("Trigger definition resume does not accept guidance or budget overrides");
      await triggers.enable(request.runId, ctx.cwd);
      return { kind: "triggerDefinition" as const, triggerId: request.runId };
    }
    await recommendSubagentsOnce(ctx);
    const unattendedRun = await unattendedResumeCandidate(ctx, request.runId);
    if (unattendedRun?.mode === "scheduled" && unattendedRun.scheduleId) {
      await scheduler.resumeOccurrence(unattendedRun.scheduleId, unattendedRun.runId, ctx.cwd);
      return { kind: "schedule" as const, run: unattendedRun };
    }
    if (unattendedRun?.mode === "proactive" && unattendedRun.triggerId) {
      await triggers.resumeOccurrence(unattendedRun.triggerId, unattendedRun.runId, ctx.cwd);
      return { kind: "trigger" as const, run: unattendedRun };
    }
    return { kind: "goal" as const, run: await goals.resume(request, goalHost) };
  };

  pi.registerCommand("loops", {
    description: "Control bounded Pi Loops goals, schedules, and triggers",
    handler: async (args, ctx) => {
      try {
        const parsed = parseCommand(args);
        const commandHost = createGoalHost(pi, ctx);
        switch (parsed.action) {
          case "goal":
            await recommendSubagentsOnce(ctx);
            await goals.start({ goal: parsed.value }, commandHost);
            break;
          case "schedule": {
            const request = parseScheduleValue(parsed.value);
            const schedule = await createSchedule(request, ctx);
            ctx.ui.notify(`${schedule.scheduleId} created — ${schedule.normalizedExpression}`, "info");
            break;
          }
          case "watch": {
            const trigger = await createTrigger(parseWatchValue(parsed.value), ctx);
            const source = trigger.source.kind === "event" ? "event bus" : trigger.source.relativePath;
            ctx.ui.notify(`${trigger.triggerId} created — ${source}`, "info");
            break;
          }
          case "status":
            ctx.ui.notify(await combinedStatus(ctx, commandHost), "info");
            break;
          case "stop":
            await stopWork(parsed.value || undefined, ctx, commandHost);
            break;
          case "resume": {
            const resumed = await resumeWork(parseResumeValue(parsed.value), ctx, commandHost);
            if (resumed.kind === "triggerDefinition") ctx.ui.notify(`${resumed.triggerId} resumed`, "info");
            break;
          }
          case "clean": {
            const evicted = await goals.clean(commandHost);
            ctx.ui.notify(evicted.length === 0 ? "No terminal run records were eligible for cleanup." : `Deleted ${evicted.length} run record(s): ${evicted.join(", ")}`, "info");
            break;
          }
          case "delete": {
            if (!parsed.value) throw new Error("Usage: /loops delete <run-id|schedule-id|trigger-id>");
            if (!ctx.hasUI) throw new Error("Runtime-data deletion requires an interactive confirmation");
            const confirmed = await ctx.ui.confirm("Delete Pi Loops runtime data?", `Permanently delete runtime data for ${parsed.value}?`);
            if (!confirmed) {
              ctx.ui.notify("Run deletion cancelled.", "info");
              break;
            }
            if (parsed.value.startsWith("schedule_")) {
              await scheduler.delete(parsed.value, ctx.cwd);
            } else if (parsed.value.startsWith("trigger_")) {
              await triggers.delete(parsed.value, ctx.cwd);
            } else {
              const run = await storedRun(ctx, parsed.value);
              if (run?.mode === "scheduled" && run.scheduleId) {
                const schedule = (await scheduler.list(ctx.cwd)).find((item) => item.scheduleId === run.scheduleId);
                if (schedule?.activeRunId === run.runId) throw new Error(`Stop the active scheduled run before deleting it: ${run.runId}`);
              }
              if (run?.mode === "proactive" && run.triggerId) {
                const trigger = (await triggers.list(ctx.cwd)).find((item) => item.triggerId === run.triggerId);
                if (trigger?.activeRunId === run.runId) throw new Error(`Stop the active proactive run before deleting it: ${run.runId}`);
              }
              await goals.delete(parsed.value, commandHost);
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
        ctx.ui.notify(errorMessage(error), "error");
      }
    },
  });

  pi.registerTool({
    name: "pi_loops",
    label: "Pi Loops",
    description: "Start, schedule, trigger, inspect, stop, or resume bounded Pi Loops work while Pi is running.",
    promptSnippet: "Control bounded goal, schedule, and proactive loops with independent completion evaluation",
    promptGuidelines: [
      "Use pi_loops goal when the user explicitly asks to keep iterating until a condition is met.",
      "Use pi_loops trigger only with an existing user-confirmed trigger ID.",
      "Do not use pi_loops for a normal one-turn task.",
      "Await delegated work and surface verifier results before claiming loop completion.",
    ],
    parameters: Type.Object({
      action: StringEnum(TOOL_ACTIONS, { description: "Pi Loops workflow action" }),
      goal: Type.Optional(Type.String({ description: "Goal condition for action=goal or schedule" })),
      scheduleExpression: Type.Optional(Type.String({ description: "Timing expression for action=schedule" })),
      verifierCommands: Type.Optional(Type.Array(Type.String(), { description: "Required commands that must succeed" })),
      constraints: Type.Optional(Type.Array(Type.String(), { description: "Constraints that must remain true" })),
      runId: Type.Optional(Type.String({ description: "Target run, schedule, or trigger ID for stop/resume" })),
      triggerId: Type.Optional(Type.String({ description: "Confirmed trigger definition for action=trigger" })),
      guidance: Type.Optional(Type.String({ description: "New guidance when resuming" })),
      maxCycles: Type.Optional(Type.Integer({ minimum: 1, description: "Finite outer-cycle limit" })),
      maxActiveMinutes: Type.Optional(Type.Integer({ minimum: 1, description: "Finite active-time limit in minutes" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const toolHost = createGoalHost(pi, ctx);
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
          const run = await goals.start(request, toolHost);
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
        case "trigger": {
          if (!params.triggerId) throw new Error("pi_loops trigger requires a trigger ID");
          const result = await triggers.fire(params.triggerId, ctx.cwd);
          return {
            content: [{ type: "text", text: `${params.triggerId} trigger ${result}` }],
            details: { triggerId: params.triggerId, result },
            terminate: true,
          };
        }
        case "status":
          return {
            content: [{ type: "text", text: await combinedStatus(ctx, toolHost) }],
            details: { activeRunId: goals.activeRunId },
          };
        case "stop": {
          const stopped = await stopWork(params.runId, ctx, toolHost);
          if (stopped.kind === "schedule" || stopped.kind === "trigger") {
            return { content: [{ type: "text", text: `${stopped.id} stopped` }], details: { workflowId: stopped.id }, terminate: true };
          }
          return toolResult(stopped.run ? `${stopped.run.runId} cancelled` : "No goal loop is active", stopped.run);
        }
        case "resume": {
          const request: GoalResumeRequest = {
            ...(params.runId === undefined ? {} : { runId: params.runId }),
            ...(params.guidance === undefined ? {} : { guidance: params.guidance }),
            ...budgetFromTool(params),
          };
          const resumed = await resumeWork(request, ctx, toolHost);
          if (resumed.kind === "triggerDefinition") {
            return { content: [{ type: "text", text: `${resumed.triggerId} resumed` }], details: { triggerId: resumed.triggerId }, terminate: true };
          }
          return toolResult(
            resumed.kind === "schedule"
              ? `${resumed.run.runId} scheduled restart requested`
              : resumed.kind === "trigger"
                ? `${resumed.run.runId} proactive restart requested`
                : `${resumed.run.runId} resumed`,
            resumed.run,
          );
        }
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    triggerEvents.deactivate();
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
      for (const run of await goals.reconcile(ctx.cwd)) {
        pi.appendEntry("pi-loops.run", conciseRunEntry(run));
        ctx.ui.notify(`${run.runId}: interrupted — recovered stale active state after startup`, "warning");
      }
    } catch (error) {
      ctx.ui.notify(`Pi Loops startup reconciliation failed: ${errorMessage(error)}`, "error");
    }
    try {
      await scheduler.start({ cwd: ctx.cwd, notify: (message, level) => ctx.ui.notify(message, level) },
        (schedule, runId, signal, kind) => unattended.runSchedule(
          schedule,
          runId,
          new CurrentModelEvaluator(ctx),
          createUnattendedHost(pi, ctx),
          signal,
          kind,
        ));
    } catch (error) {
      ctx.ui.notify(`Pi Loops scheduler startup failed: ${errorMessage(error)}`, "error");
    }
    try {
      await triggers.start(
        { cwd: ctx.cwd, notify: (message, level) => ctx.ui.notify(message, level) },
        (trigger, runId, signal, kind) => unattended.runTrigger(
          trigger,
          runId,
          new CurrentModelEvaluator(ctx),
          createUnattendedHost(pi, ctx),
          signal,
          kind,
        ),
      );
      triggerEvents.activate(ctx);
    } catch (error) {
      ctx.ui.notify(`Pi Loops trigger startup failed: ${errorMessage(error)}`, "error");
    }
  });

  pi.on("tool_result", async (event) => {
    goals.recordToolResult({
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: event.input,
      content: event.content,
      isError: event.isError,
    });
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!goals.activeRunId) return;
    await goals.settle(lastAssistantText(ctx), new CurrentModelEvaluator(ctx), createGoalHost(pi, ctx));
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    triggerEvents.deactivate();
    await shutdownUnattendedControllers({
      shutdownScheduler: () => scheduler.shutdown(),
      shutdownTriggers: () => triggers.shutdown(),
      shutdownWorker: () => unattended.shutdown(),
      interruptAttended: () => goals.interrupt(createGoalHost(pi, ctx)),
    });
  });
}
