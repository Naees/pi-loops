import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ParentWorkerUi } from "../ui/worker-ui-relay.js";
import { relayWorkerUiRequest } from "../ui/worker-ui-relay.js";
import { resolveCurrentPiLaunchCommand, type PiLaunchCommand } from "./pi-executable.js";
import { RpcWorkerClient, type RpcEnvelope } from "./rpc-client.js";
import { CHILD_DEADLINE_ENV, CHILD_MARKER_ENV } from "./watchdog.js";

const SUPPORTED_PI_VERSION = "0.80.6";

export class WorkerInteractionRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerInteractionRequiredError";
  }
}

export interface WorkerLaunchSpec {
  readonly runId: string;
  readonly cwd: string;
  readonly sessionDirectory: string;
  readonly absoluteDeadlineMs: number;
  readonly sessionFile?: string;
}

export interface WorkerIdentity {
  readonly pid: number;
  readonly ownershipToken: string;
  readonly piVersion: string;
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly cwd: string;
  readonly startedAt: string;
}

export interface WorkerCycleResult {
  readonly lastAssistantText: string | null;
  readonly events: readonly RpcEnvelope[];
}

function responseData(response: RpcEnvelope): Record<string, unknown> {
  if (response.type !== "response" || response.success !== true || typeof response.data !== "object" || response.data === null) {
    throw new Error(`RPC worker returned invalid response data: ${JSON.stringify(response)}`);
  }
  return response.data as Record<string, unknown>;
}

function futureDeadline(value: number): void {
  if (!Number.isSafeInteger(value) || value <= Date.now()) throw new Error("RPC worker requires a future absolute deadline");
}

export class ManagedRpcWorker {
  readonly identity: WorkerIdentity;
  readonly #client: RpcWorkerClient;
  readonly #ui: ParentWorkerUi;

  constructor(identity: WorkerIdentity, client: RpcWorkerClient, ui: ParentWorkerUi) {
    this.identity = identity;
    this.#client = client;
    this.#ui = ui;
  }

  async runCycle(message: string, signal?: AbortSignal): Promise<WorkerCycleResult> {
    if (!message.trim()) throw new Error("RPC worker prompt must not be empty");
    const checkpoint = this.#client.checkpoint();
    const prompt = this.#client.request({ type: "prompt", message }, signal);
    await prompt;
    let cursor = checkpoint;
    while (true) {
      const event = await this.#client.waitFor(() => true, { after: cursor, ...(signal === undefined ? {} : { signal }) });
      const index = this.#client.events.indexOf(event, cursor);
      cursor = index < 0 ? this.#client.checkpoint() : index + 1;
      if (event.type === "extension_ui_request") {
        const result = await relayWorkerUiRequest(event, this.#ui, signal ?? new AbortController().signal);
        if (!result.handled) throw new WorkerInteractionRequiredError(result.reason);
        if (result.response) this.#client.write(result.response);
      }
      if (event.type === "agent_settled") {
        const response = responseData(await this.#client.request({ type: "get_last_assistant_text" }, signal));
        return {
          lastAssistantText: typeof response.text === "string" ? response.text : null,
          events: this.#client.events.slice(checkpoint, cursor),
        };
      }
    }
  }

  async abort(signal?: AbortSignal): Promise<void> {
    await this.#client.request({ type: "abort" }, signal);
  }

  stop(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    return this.#client.stop();
  }
}

export class RpcWorkerManager {
  readonly #resolveLaunch: () => Promise<PiLaunchCommand>;
  readonly #extensionPath: string;
  readonly #platform: NodeJS.Platform;

  constructor(options: { resolveLaunch?: () => Promise<PiLaunchCommand>; extensionPath?: string; platform?: NodeJS.Platform } = {}) {
    this.#resolveLaunch = options.resolveLaunch ?? resolveCurrentPiLaunchCommand;
    this.#extensionPath = options.extensionPath ?? fileURLToPath(new URL("../extension/index.ts", import.meta.url));
    this.#platform = options.platform ?? process.platform;
  }

  async launch(spec: WorkerLaunchSpec, ui: ParentWorkerUi): Promise<ManagedRpcWorker> {
    if (this.#platform !== "darwin") throw new Error("Scheduled RPC writers are currently validated only on macOS");
    futureDeadline(spec.absoluteDeadlineMs);
    const cwd = await realpath(spec.cwd);
    await mkdir(spec.sessionDirectory, { recursive: true, mode: 0o700 });
    const sessionDirectory = await realpath(spec.sessionDirectory);
    const launch = await this.#resolveLaunch();
    if (launch.version !== SUPPORTED_PI_VERSION) {
      throw new Error(`Scheduled RPC writers require validated Pi ${SUPPORTED_PI_VERSION}; current Pi is ${launch.version}`);
    }
    const ownershipToken = randomUUID();
    const args = [
      ...launch.argsPrefix,
      "--mode", "rpc",
      "--extension", this.#extensionPath,
      "--session-dir", sessionDirectory,
      ...(spec.sessionFile === undefined ? [] : ["--session", spec.sessionFile]),
    ];
    const client = new RpcWorkerClient({
      executable: launch.executable,
      args,
      cwd,
      environment: {
        ...process.env,
        [CHILD_MARKER_ENV]: ownershipToken,
        [CHILD_DEADLINE_ENV]: String(spec.absoluteDeadlineMs),
      },
    });
    try {
      const state = responseData(await client.request({ type: "get_state" }));
      if (state.isStreaming !== false || typeof state.sessionId !== "string" || typeof state.sessionFile !== "string") {
        throw new Error(`RPC worker handshake is invalid: ${JSON.stringify(state)}`);
      }
      if (!isAbsolute(state.sessionFile)) throw new Error("RPC worker reported a non-absolute session file");
      const reportedSessionFile = resolve(state.sessionFile);
      let sessionFile: string;
      try {
        sessionFile = await realpath(reportedSessionFile);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        try {
          await lstat(reportedSessionFile);
          throw new Error("RPC worker reported an unresolved session-file symlink");
        } catch (metadataError) {
          if ((metadataError as NodeJS.ErrnoException).code !== "ENOENT") throw metadataError;
        }
        sessionFile = join(await realpath(dirname(reportedSessionFile)), basename(reportedSessionFile));
      }
      const sessionRelation = relative(sessionDirectory, sessionFile);
      if (sessionRelation.startsWith("..") || isAbsolute(sessionRelation) || sessionRelation === "") {
        throw new Error("RPC worker session file escapes its managed session directory");
      }
      if (spec.sessionFile !== undefined && sessionFile !== await realpath(spec.sessionFile)) {
        throw new Error("RPC worker resumed a different session file");
      }
      return new ManagedRpcWorker({ 
        pid: client.pid,
        ownershipToken,
        piVersion: launch.version,
        sessionId: state.sessionId,
        sessionFile,
        cwd,
        startedAt: new Date().toISOString(),
      }, client, ui);
    } catch (error) {
      await client.stop().catch(() => undefined);
      throw error;
    }
  }
}
