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
} {
  const registerCommand = vi.fn();
  const registerTool = vi.fn();
  const on = vi.fn();
  const getAllTools = vi.fn(() => []);
  const getCommands = vi.fn(() => []);
  const sendUserMessage = vi.fn();
  const appendEntry = vi.fn();
  return {
    api: { registerCommand, registerTool, on, getAllTools, getCommands, sendUserMessage, appendEntry } as unknown as ExtensionAPI,
    registerCommand,
    registerTool,
    on,
    getAllTools,
    getCommands,
    sendUserMessage,
    appendEntry,
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
