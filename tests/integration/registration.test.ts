import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import piLoopsExtension, { toolProvenanceMatches } from "../../src/extension/index.js";

const originalChildMarker = process.env.PI_LOOPS_CHILD;
const originalAgentDirectory = process.env.PI_CODING_AGENT_DIR;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  if (originalChildMarker === undefined) {
    delete process.env.PI_LOOPS_CHILD;
  } else {
    process.env.PI_LOOPS_CHILD = originalChildMarker;
  }
  if (originalAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDirectory;
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function mockApi(): {
  api: ExtensionAPI;
  registerCommand: ReturnType<typeof vi.fn>;
  registerTool: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  getAllTools: ReturnType<typeof vi.fn>;
  getCommands: ReturnType<typeof vi.fn>;
  sendUserMessage: ReturnType<typeof vi.fn>;
  appendEntry: ReturnType<typeof vi.fn>;
  eventOn: ReturnType<typeof vi.fn>;
} {
  const registerCommand = vi.fn();
  const registerTool = vi.fn();
  const on = vi.fn();
  const getAllTools = vi.fn(() => []);
  const getCommands = vi.fn(() => []);
  const sendUserMessage = vi.fn();
  const appendEntry = vi.fn();
  const eventOn = vi.fn(() => vi.fn());
  return {
    api: { registerCommand, registerTool, on, getAllTools, getCommands, sendUserMessage, appendEntry, events: { on: eventOn, emit: vi.fn() } } as unknown as ExtensionAPI,
    registerCommand,
    registerTool,
    on,
    getAllTools,
    getCommands,
    sendUserMessage,
    appendEntry,
    eventOn,
  };
}

async function context(): Promise<{ ctx: ExtensionContext; notifications: { message: string; level: string }[] }> {
  const project = await mkdtemp(join(tmpdir(), "pi-loops-extension-project-"));
  const agentDirectory = await mkdtemp(join(tmpdir(), "pi-loops-extension-agent-"));
  temporaryDirectories.push(project, agentDirectory);
  process.env.PI_CODING_AGENT_DIR = agentDirectory;
  const notifications: { message: string; level: string }[] = [];
  return {
    ctx: {
      cwd: project,
      hasUI: true,
      isIdle: () => true,
      abort: vi.fn(),
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
        select: vi.fn(async () => undefined),
        confirm: vi.fn(async () => false),
      },
    } as unknown as ExtensionContext,
    notifications,
  };
}

describe("Pi extension registration", () => {
  it("compares effective tool provenance against this extension path", () => {
    expect(toolProvenanceMatches("/package/src/extension/index.ts", "/package/src/extension/index.ts")).toBe(true);
    expect(toolProvenanceMatches("/other/index.ts", "/package/src/extension/index.ts")).toBe(false);
  });

  it("registers the namespaced command and tool in a parent process", () => {
    delete process.env.PI_LOOPS_CHILD;
    const { api, registerCommand, registerTool } = mockApi();

    piLoopsExtension(api);

    expect(registerCommand).toHaveBeenCalledWith("loops", expect.any(Object));
    expect(registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "pi_loops" }));
  });

  it("executes the public goal, status, and stop tool contract with finite budgets", async () => {
    delete process.env.PI_LOOPS_CHILD;
    const { ctx, notifications } = await context();
    const { api, registerTool, sendUserMessage, appendEntry } = mockApi();
    piLoopsExtension(api);
    const tool = registerTool.mock.calls[0]?.[0] as {
      execute(toolCallId: string, params: Record<string, unknown>, signal: AbortSignal, onUpdate: undefined, context: ExtensionContext): Promise<{ content: { text: string }[]; details: Record<string, unknown> }>;
    };

    await expect(tool.execute("call-0", { action: "goal", goal: "   " }, new AbortController().signal, undefined, ctx))
      .rejects.toThrow("requires a non-empty goal");
    const started = await tool.execute("call-1", {
      action: "goal",
      goal: "finish safely",
      maxCycles: 2,
      maxActiveMinutes: 3,
    }, new AbortController().signal, undefined, ctx);
    expect(started.content[0]?.text).toMatch(/^run_[0-9a-f]{8} started$/);
    expect(started.details).toEqual(expect.objectContaining({ state: "running", runId: expect.stringMatching(/^run_[0-9a-f]{8}$/) }));
    expect(notifications.some(({ message }) => message.includes("Budget: 2 cycles / 3 minutes"))).toBe(true);
    expect(sendUserMessage).toHaveBeenCalledOnce();

    const status = await tool.execute("call-2", { action: "status" }, new AbortController().signal, undefined, ctx);
    expect(status.content[0]?.text).toContain("finish safely");
    const stopped = await tool.execute("call-3", { action: "stop", runId: started.details.runId }, new AbortController().signal, undefined, ctx);
    expect(stopped.content[0]?.text).toContain("cancelled");
    expect(appendEntry).toHaveBeenCalledWith("pi-loops.run", expect.objectContaining({ state: "cancelled" }));
  });

  it("deletes a stopped goal run through the confirmed public command", async () => {
    delete process.env.PI_LOOPS_CHILD;
    const { ctx, notifications } = await context();
    ctx.ui.confirm = vi.fn(async () => true);
    const { api, registerCommand, registerTool } = mockApi();
    piLoopsExtension(api);
    const command = registerCommand.mock.calls[0]?.[1] as { handler(args: string, context: ExtensionContext): Promise<void> };
    const tool = registerTool.mock.calls[0]?.[0] as {
      execute(toolCallId: string, params: Record<string, unknown>, signal: AbortSignal, onUpdate: undefined, context: ExtensionContext): Promise<{ content: { text: string }[]; details: Record<string, unknown> }>;
    };

    const started = await tool.execute("start", { action: "goal", goal: "delete after stopping" }, new AbortController().signal, undefined, ctx);
    const runId = started.details.runId as string;
    await tool.execute("stop", { action: "stop", runId }, new AbortController().signal, undefined, ctx);
    await command.handler(`delete ${runId}`, ctx);
    expect(notifications.at(-1)?.message).toBe(`Deleted Pi Loops runtime data for ${runId}.`);
    const status = await tool.execute("status", { action: "status" }, new AbortController().signal, undefined, ctx);
    expect(status.content[0]?.text).not.toContain(runId);

    await command.handler(`delete ${runId}`, ctx);
    expect(notifications.at(-1)).toEqual(expect.objectContaining({ level: "error", message: `Run not found: ${runId}` }));
  });

  it("validates, confirms, and persists schedules through the model-facing tool", async () => {
    delete process.env.PI_LOOPS_CHILD;
    const { ctx } = await context();
    const { api, registerTool } = mockApi();
    piLoopsExtension(api);
    const tool = registerTool.mock.calls[0]?.[0] as {
      execute(toolCallId: string, params: Record<string, unknown>, signal: AbortSignal, onUpdate: undefined, context: ExtensionContext): Promise<{ content: { text: string }[]; details: Record<string, unknown> }>;
    };

    await expect(tool.execute("call-0", { action: "schedule", goal: "checks" }, new AbortController().signal, undefined, ctx))
      .rejects.toThrow("requires a timing expression and non-empty goal");
    (ctx as { hasUI: boolean }).hasUI = false;
    await expect(tool.execute("call-no-ui", {
      action: "schedule",
      goal: "checks",
      scheduleExpression: "every 5m",
    }, new AbortController().signal, undefined, ctx)).rejects.toThrow("requires interactive confirmation");
    (ctx as { hasUI: boolean }).hasUI = true;
    await expect(tool.execute("call-1", {
      action: "schedule",
      goal: "checks",
      scheduleExpression: "every 5m",
    }, new AbortController().signal, undefined, ctx)).rejects.toThrow("Schedule creation cancelled");

    ctx.ui.confirm = vi.fn(async () => true);
    const created = await tool.execute("call-2", {
      action: "schedule",
      goal: "checks",
      scheduleExpression: "every 5m",
      verifierCommands: ["npm test"],
      maxCycles: 2,
      maxActiveMinutes: 3,
    }, new AbortController().signal, undefined, ctx);
    expect(created.content[0]?.text).toMatch(/^schedule_[0-9a-f]{8} created — every 5 minutes$/);
    expect(created.details).toEqual(expect.objectContaining({
      scheduleId: expect.stringMatching(/^schedule_[0-9a-f]{8}$/),
      nextFireAt: expect.any(String),
    }));
    expect(ctx.ui.confirm).toHaveBeenCalledWith("Create Pi Loops schedule?", expect.stringContaining("Budget: 2 cycles / 3 active minutes"));
  });

  it("normalizes and confirms schedules before persisting them", async () => {
    delete process.env.PI_LOOPS_CHILD;
    const { ctx, notifications } = await context();
    ctx.ui.confirm = vi.fn(async () => true);
    const { api, registerCommand } = mockApi();
    piLoopsExtension(api);
    const command = registerCommand.mock.calls[0]?.[1] as { handler(args: string, context: ExtensionContext): Promise<void> };

    await command.handler("schedule every 5m -- run checks", ctx);

    expect(ctx.ui.confirm).toHaveBeenCalledWith(
      "Create Pi Loops schedule?",
      expect.stringContaining("When: every 5 minutes"),
    );
    expect(notifications.some(({ message, level }) => level === "info" && /^schedule_[0-9a-f]{8} created/.test(message))).toBe(true);
    await command.handler("status", ctx);
    expect(notifications.at(-1)?.message).toContain("Schedules:");
    expect(notifications.at(-1)?.message).toContain("run checks");
  });

  it("fails closed for trigger confirmation and deletion through the public command", async () => {
    delete process.env.PI_LOOPS_CHILD;
    const { ctx, notifications } = await context();
    const { api, registerCommand } = mockApi();
    piLoopsExtension(api);
    const command = registerCommand.mock.calls[0]?.[1] as { handler(args: string, context: ExtensionContext): Promise<void> };

    (ctx as { hasUI: boolean }).hasUI = false;
    await command.handler("watch event -- handle output", ctx);
    expect(notifications.at(-1)).toEqual(expect.objectContaining({
      level: "error",
      message: "Trigger creation requires interactive confirmation",
    }));
    (ctx as { hasUI: boolean }).hasUI = true;
    await command.handler("watch event -- handle output", ctx);
    expect(notifications.at(-1)).toEqual(expect.objectContaining({ level: "error", message: "Trigger creation cancelled" }));

    ctx.ui.confirm = vi.fn(async () => true);
    await command.handler("watch event -- handle output", ctx);
    const triggerId = notifications.at(-1)?.message.match(/^trigger_[0-9a-f]{8}/)?.[0];
    expect(triggerId).toBeDefined();
    (ctx as { hasUI: boolean }).hasUI = false;
    await command.handler(`delete ${triggerId}`, ctx);
    expect(notifications.at(-1)?.message).toBe("Runtime-data deletion requires an interactive confirmation");
    (ctx as { hasUI: boolean }).hasUI = true;
    ctx.ui.confirm = vi.fn(async () => false);
    await command.handler(`delete ${triggerId}`, ctx);
    expect(notifications.at(-1)?.message).toBe("Run deletion cancelled.");
    await command.handler("status", ctx);
    expect(notifications.at(-1)?.message).toContain(triggerId);

    ctx.ui.confirm = vi.fn(async () => true);
    await command.handler(`delete ${triggerId}`, ctx);
    expect(notifications.at(-1)?.message).toBe(`Deleted Pi Loops runtime data for ${triggerId}.`);
    await command.handler("status", ctx);
    expect(notifications.at(-1)?.message).not.toContain(triggerId);
  });

  it("creates confirmed triggers and accepts only the namespaced event contract", async () => {
    delete process.env.PI_LOOPS_CHILD;
    const { ctx, notifications } = await context();
    ctx.ui.confirm = vi.fn(async () => true);
    const mocked = mockApi();
    piLoopsExtension(mocked.api);
    const command = mocked.registerCommand.mock.calls[0]?.[1] as { handler(args: string, context: ExtensionContext): Promise<void> };
    const tool = mocked.registerTool.mock.calls[0]?.[0] as {
      execute(toolCallId: string, params: Record<string, unknown>, signal: AbortSignal, onUpdate: undefined, context: ExtensionContext): Promise<{ content: { text: string }[]; details: Record<string, unknown> }>;
    };
    const start = mocked.on.mock.calls.find(([event]) => event === "session_start")?.[1] as
      ((_event: unknown, context: ExtensionContext) => Promise<void>) | undefined;
    const shutdown = mocked.on.mock.calls.find(([event]) => event === "session_shutdown")?.[1] as
      ((_event: unknown, context: ExtensionContext) => Promise<void>) | undefined;
    const eventHandler = mocked.eventOn.mock.calls.find(([event]) => event === "pi-loops:trigger")?.[1] as
      ((payload: unknown) => void) | undefined;

    await start?.({}, ctx);
    await command.handler("watch event -- handle build output", ctx);
    const triggerId = notifications.at(-1)?.message.match(/^trigger_[0-9a-f]{8}/)?.[0];
    expect(triggerId).toBeDefined();
    expect(ctx.ui.confirm).toHaveBeenCalledWith("Create Pi Loops trigger?", expect.stringContaining("event bus: pi-loops:trigger"));
    await command.handler("status", ctx);
    expect(notifications.at(-1)?.message).toContain("Triggers:");
    expect(notifications.at(-1)?.message).toContain("handle build output");

    await expect(tool.execute("stop-trigger", { action: "stop", runId: triggerId }, new AbortController().signal, undefined, ctx))
      .resolves.toEqual(expect.objectContaining({ details: { workflowId: triggerId } }));
    await expect(tool.execute("paused-trigger", { action: "trigger", triggerId }, new AbortController().signal, undefined, ctx))
      .resolves.toEqual(expect.objectContaining({ details: { triggerId, result: "ignored" } }));
    await expect(tool.execute("resume-trigger", { action: "resume", runId: triggerId }, new AbortController().signal, undefined, ctx))
      .resolves.toEqual(expect.objectContaining({ details: { triggerId } }));
    await expect(tool.execute("trigger-call", { action: "trigger", triggerId }, new AbortController().signal, undefined, ctx))
      .resolves.toEqual(expect.objectContaining({ details: { triggerId, result: "started" } }));
    await vi.waitFor(() => expect(mocked.appendEntry).toHaveBeenCalledWith(
      "pi-loops.run",
      expect.objectContaining({ state: "awaiting_user" }),
    ));
    const proactiveRun = mocked.appendEntry.mock.calls.find(([type, record]) =>
      type === "pi-loops.run" && (record as { state?: string }).state === "awaiting_user",
    )?.[1] as { runId: string } | undefined;
    expect(proactiveRun).toBeDefined();
    await vi.waitFor(async () => {
      await command.handler("status", ctx);
      expect(notifications.at(-1)?.message).toContain(`${triggerId}  enabled`);
    });
    await expect(tool.execute("resume-proactive-budget", {
      action: "resume",
      runId: proactiveRun?.runId,
      maxCycles: 2,
    }, new AbortController().signal, undefined, ctx)).rejects.toThrow("Unattended run resume does not accept budget overrides");
    await expect(tool.execute("resume-proactive", {
      action: "resume",
      runId: proactiveRun?.runId,
      guidance: "inspect the generated files",
    }, new AbortController().signal, undefined, ctx))
      .resolves.toEqual(expect.objectContaining({ content: [{ type: "text", text: expect.stringContaining("proactive restart requested") }] }));
    for (let index = 0; index < 20; index += 1) {
      eventHandler?.({ schemaVersion: 1, triggerId, goal: `hostile injection ${index}` });
    }
    const rejectedNotices = notifications.filter(({ message }) => message.includes("rejected trigger event") && message.includes("invalid payload"));
    expect(rejectedNotices).toHaveLength(1);
    await shutdown?.({}, ctx);
  });

  it("supports help, unsupported-command diagnostics, and confirmed schedule deletion", async () => {
    delete process.env.PI_LOOPS_CHILD;
    const { ctx, notifications } = await context();
    ctx.ui.confirm = vi.fn(async () => true);
    const { api, registerCommand } = mockApi();
    piLoopsExtension(api);
    const command = registerCommand.mock.calls[0]?.[1] as { handler(args: string, context: ExtensionContext): Promise<void> };

    await command.handler("help", ctx);
    expect(notifications.at(-1)?.message).toContain("/loops schedule <time-expression> -- <goal>");
    await command.handler("future files", ctx);
    expect(notifications.at(-1)).toEqual(expect.objectContaining({ level: "warning", message: "Unknown Pi Loops subcommand: future" }));
    await command.handler("goal", ctx);
    expect(notifications.at(-1)).toEqual(expect.objectContaining({ level: "error", message: "Usage: /loops goal <goal>" }));

    await command.handler("schedule in 1h -- delete me", ctx);
    const scheduleId = notifications.at(-1)?.message.match(/^schedule_[0-9a-f]{8}/)?.[0];
    expect(scheduleId).toBeDefined();
    await command.handler(`delete ${scheduleId}`, ctx);
    expect(notifications.at(-1)?.message).toBe(`Deleted Pi Loops runtime data for ${scheduleId}.`);
    await command.handler("status", ctx);
    expect(notifications.at(-1)?.message).not.toContain("delete me");
  });

  it("resumes an interrupted goal through the public tool with a new budget epoch", async () => {
    delete process.env.PI_LOOPS_CHILD;
    const { ctx } = await context();
    const { api, registerTool, on, sendUserMessage } = mockApi();
    piLoopsExtension(api);
    const tool = registerTool.mock.calls[0]?.[0] as {
      execute(toolCallId: string, params: Record<string, unknown>, signal: AbortSignal, onUpdate: undefined, context: ExtensionContext): Promise<{ content: { text: string }[]; details: Record<string, unknown> }>;
    };
    const shutdown = on.mock.calls.find(([event]) => event === "session_shutdown")?.[1] as
      ((_event: unknown, context: ExtensionContext) => Promise<void>) | undefined;
    expect(shutdown).toBeTypeOf("function");

    const started = await tool.execute("call-1", { action: "goal", goal: "resume safely" }, new AbortController().signal, undefined, ctx);
    await shutdown?.({}, ctx);
    const resumed = await tool.execute("call-2", {
      action: "resume",
      runId: started.details.runId,
      guidance: "continue",
      maxCycles: 2,
      maxActiveMinutes: 1,
    }, new AbortController().signal, undefined, ctx);

    expect(resumed.content[0]?.text).toBe(`${started.details.runId} resumed`);
    expect(resumed.details).toEqual(expect.objectContaining({ state: "running", cycle: 0 }));
    expect(sendUserMessage).toHaveBeenCalledTimes(2);
  });

  it("runs startup diagnostics and ordered shutdown handlers", async () => {
    delete process.env.PI_LOOPS_CHILD;
    const { ctx, notifications } = await context();
    const mocked = mockApi();
    mocked.getCommands.mockReturnValue([{ name: "loops" }, { name: "loops:2" }]);
    piLoopsExtension(mocked.api);
    const start = mocked.on.mock.calls.find(([event]) => event === "session_start")?.[1] as
      ((_event: unknown, context: ExtensionContext) => Promise<void>) | undefined;
    const shutdown = mocked.on.mock.calls.find(([event]) => event === "session_shutdown")?.[1] as
      ((_event: unknown, context: ExtensionContext) => Promise<void>) | undefined;
    expect(start).toBeTypeOf("function");
    expect(shutdown).toBeTypeOf("function");

    await start?.({}, ctx);
    expect(notifications).toEqual(expect.arrayContaining([
      expect.objectContaining({ level: "error", message: "Pi Loops tool registration is unavailable in this session." }),
      expect.objectContaining({ level: "warning", message: expect.stringContaining("command collision detected") }),
    ]));
    await shutdown?.({}, ctx);
  });

  it("suppresses the outer controller in child worker mode", () => {
    process.env.PI_LOOPS_CHILD = "run_1234abcd";
    const { api, registerCommand, registerTool, on } = mockApi();

    piLoopsExtension(api);

    expect(registerCommand).not.toHaveBeenCalled();
    expect(registerTool).not.toHaveBeenCalled();
    expect(on).toHaveBeenCalledWith("session_start", expect.any(Function));
    expect(on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
  });
});
