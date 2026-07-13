import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveCurrentPiLaunchCommand } from "../../src/worker/pi-executable.ts";

const PROVIDER = "pi-loops-lifecycle";
const MODEL = "controlled";
const STREAM_DELAY_MS = 30_000;

function emptyAssistant(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function latestUserText(context: Context): string {
  const message = [...context.messages].reverse().find((candidate) => candidate.role === "user");
  if (!message || message.role !== "user") return "";
  return typeof message.content === "string"
    ? message.content
    : message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

function hasToolResult(context: Context): boolean {
  return context.messages.some((message) => message.role === "toolResult");
}

function abortableDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("controlled stream aborted"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("controlled stream aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function descendantCommand(pidFile: string): string {
  const code = [
    "const fs = require('node:fs');",
    "const { spawn } = require('node:child_process');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    `fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ parentPid: process.pid, childPid: child.pid }));`,
    "setInterval(() => {}, 1000);",
  ].join(" ");
  const executable = process.platform === "win32" ? process.execPath.replaceAll("\\", "/") : process.execPath;
  return `${shellQuote(executable)} -e ${shellQuote(code)}`;
}

function emitText(stream: AssistantMessageEventStream, output: AssistantMessage, text: string): void {
  output.content.push({ type: "text", text });
  const contentIndex = output.content.length - 1;
  stream.push({ type: "text_start", contentIndex, partial: output });
  stream.push({ type: "text_delta", contentIndex, delta: text, partial: output });
  stream.push({ type: "text_end", contentIndex, content: text, partial: output });
}

function streamControlled(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  void (async () => {
    const output = emptyAssistant(model);
    try {
      stream.push({ type: "start", partial: output });
      const prompt = latestUserText(context);

      if (prompt.includes("PI_LOOPS_SPIKE_STREAM")) {
        emitText(stream, output, "controlled-stream-started");
        await abortableDelay(STREAM_DELAY_MS, options?.signal);
        emitText(stream, output, "controlled-stream-finished");
      } else if (prompt.includes("PI_LOOPS_SPIKE_TOOL") && !hasToolResult(context)) {
        const pidFile = process.env.PI_LOOPS_SPIKE_PID_FILE;
        if (!pidFile) throw new Error("PI_LOOPS_SPIKE_PID_FILE is required");
        const toolCall = {
          type: "toolCall" as const,
          id: "pi_loops_lifecycle_tool",
          name: "bash",
          arguments: { command: descendantCommand(pidFile) },
        };
        output.content.push(toolCall);
        const contentIndex = output.content.length - 1;
        stream.push({ type: "toolcall_start", contentIndex, partial: output });
        stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
        output.stopReason = "toolUse";
      } else {
        emitText(stream, output, hasToolResult(context) ? "controlled-tool-finished" : "controlled-complete");
      }

      stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();
  return stream;
}

export default function rpcLifecycleFixture(pi: ExtensionAPI): void {
  pi.registerProvider(PROVIDER, {
    name: "Pi Loops controlled lifecycle fixture",
    baseUrl: "http://127.0.0.1/unused",
    apiKey: "fixture-key",
    api: "pi-loops-controlled",
    models: [{
      id: MODEL,
      name: "Pi Loops controlled lifecycle model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 16_384,
      maxTokens: 1_024,
    }],
    streamSimple: streamControlled,
  });

  pi.registerCommand("rpc-lifecycle-launch-command", {
    description: "Report the production current-Pi launch resolution",
    handler: async (_args, ctx) => {
      const command = await resolveCurrentPiLaunchCommand();
      ctx.ui.notify(`PI_LOOPS_LAUNCH_COMMAND ${JSON.stringify(command)}`, "info");
    },
  });

  pi.registerCommand("rpc-lifecycle-confirm", {
    description: "Exercise the RPC extension UI response relay",
    handler: async (_args, ctx) => {
      const confirmed = await ctx.ui.confirm("Pi Loops lifecycle spike", "Relay this confirmation through RPC.");
      ctx.ui.notify(confirmed ? "PI_LOOPS_UI_RELAY_CONFIRMED" : "PI_LOOPS_UI_RELAY_CANCELLED", confirmed ? "info" : "warning");
    },
  });
}
