import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { RpcJsonlDecoder } from "../../src/worker/rpc-jsonl.ts";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_EVENT_TIMEOUT_MS = 30_000;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_RETAINED_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_MESSAGES = 10_000;

export interface RpcEnvelope extends Record<string, unknown> {
  readonly type: string;
  readonly id?: string;
}

interface PendingRequest {
  readonly command: string;
  readonly resolve: (message: RpcEnvelope) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

interface MessageWaiter {
  readonly after: number;
  readonly predicate: (message: RpcEnvelope) => boolean;
  readonly resolve: (message: RpcEnvelope) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

function isEnvelope(value: unknown): value is RpcEnvelope {
  return typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as Record<string, unknown>).type === "string";
}

export class RpcSpikeClient {
  readonly child: ChildProcessWithoutNullStreams;
  readonly messages: RpcEnvelope[] = [];
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  #stderr = "";
  #requestSequence = 0;
  #retainedMessageBytes = 0;
  #pending = new Map<string, PendingRequest>();
  #waiters = new Set<MessageWaiter>();
  #failure: Error | undefined;

  constructor(command: string, args: readonly string[], options: Omit<SpawnOptionsWithoutStdio, "stdio"> = {}) {
    this.child = spawn(command, [...args], { ...options, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    this.exited = new Promise((resolve) => {
      this.child.once("exit", (code, signal) => resolve({ code, signal }));
    });

    const decoder = new RpcJsonlDecoder({ maxLineBytes: 1024 * 1024 });
    this.child.stdout.on("data", (chunk: Buffer) => {
      try {
        for (const value of decoder.push(chunk)) this.#handle(value);
      } catch (error) {
        this.#fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    this.child.stdout.on("end", () => {
      try {
        for (const value of decoder.finish()) this.#handle(value);
      } catch (error) {
        this.#fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      if (this.#failure) return;
      const combined = Buffer.concat([Buffer.from(this.#stderr, "utf8"), chunk]);
      if (combined.byteLength > MAX_STDERR_BYTES) {
        this.#stderr = combined.subarray(combined.byteLength - MAX_STDERR_BYTES).toString("utf8");
        this.#fail(new Error(`RPC stderr exceeds ${MAX_STDERR_BYTES} bytes`));
        return;
      }
      this.#stderr = combined.toString("utf8");
    });
    this.child.once("error", (error) => this.#fail(error));
    void this.exited.then(({ code, signal }) => {
      if (!this.#failure && (this.#pending.size > 0 || this.#waiters.size > 0)) {
        this.#fail(new Error(`RPC child exited unexpectedly: ${JSON.stringify({ code, signal })}\nstderr:\n${this.#stderr}`));
      }
    });
  }

  get stderr(): string {
    return this.#stderr;
  }

  checkpoint(): number {
    return this.messages.length;
  }

  write(command: Record<string, unknown>): void {
    if (this.#failure) throw this.#failure;
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  async send(command: Record<string, unknown>, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<RpcEnvelope> {
    if (this.#failure) throw this.#failure;
    const type = command.type;
    if (typeof type !== "string" || type.length === 0) throw new Error("RPC command requires a type");
    const id = `spike_${++this.#requestSequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`RPC request timed out: ${type}\nstderr:\n${this.#stderr}`));
      }, timeoutMs);
      this.#pending.set(id, { command: type, resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`, (error) => {
        if (!error) return;
        const pending = this.#pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.#pending.delete(id);
        pending.reject(error);
      });
    });
  }

  waitFor(
    predicate: (message: RpcEnvelope) => boolean,
    options: { after?: number; timeoutMs?: number } = {},
  ): Promise<RpcEnvelope> {
    const after = options.after ?? 0;
    const existing = this.messages.slice(after).find(predicate);
    if (existing) return Promise.resolve(existing);
    if (this.#failure) return Promise.reject(this.#failure);

    return new Promise((resolve, reject) => {
      const waiter: MessageWaiter = {
        after,
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#waiters.delete(waiter);
          reject(new Error(`RPC event timed out after ${options.timeoutMs ?? DEFAULT_EVENT_TIMEOUT_MS}ms\nstderr:\n${this.#stderr}`));
        }, options.timeoutMs ?? DEFAULT_EVENT_TIMEOUT_MS),
      };
      this.#waiters.add(waiter);
    });
  }

  closeStdin(): void {
    this.child.stdin.end();
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    return this.child.kill(signal);
  }

  async stop(graceMs = 2_000): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.stdin.end();
    const graceful = await Promise.race([this.exited.then(() => true), new Promise<false>((resolve) => setTimeout(() => resolve(false), graceMs))]);
    if (graceful) return;
    this.child.kill("SIGTERM");
    const terminated = await Promise.race([this.exited.then(() => true), new Promise<false>((resolve) => setTimeout(() => resolve(false), graceMs))]);
    if (terminated) return;
    this.child.kill("SIGKILL");
    await this.exited;
  }

  #handle(value: unknown): void {
    if (this.#failure) return;
    if (!isEnvelope(value)) throw new Error("RPC stream emitted an invalid envelope");
    if (this.messages.length >= MAX_MESSAGES) throw new Error(`RPC stream exceeds ${MAX_MESSAGES} messages`);
    const messageBytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    if (this.#retainedMessageBytes + messageBytes > MAX_RETAINED_MESSAGE_BYTES) {
      throw new Error(`Retained RPC messages exceed ${MAX_RETAINED_MESSAGE_BYTES} bytes`);
    }
    this.#retainedMessageBytes += messageBytes;
    this.messages.push(value);

    if (value.type === "response" && typeof value.id === "string") {
      const pending = this.#pending.get(value.id);
      if (pending) {
        if (value.command !== pending.command) {
          this.#fail(new Error(`RPC response command mismatch: expected ${pending.command}, received ${String(value.command)}`));
          return;
        }
        clearTimeout(pending.timer);
        this.#pending.delete(value.id);
        if (value.success === false) pending.reject(new Error(typeof value.error === "string" ? value.error : `RPC ${pending.command} failed`));
        else pending.resolve(value);
      }
    }

    const index = this.messages.length - 1;
    for (const waiter of [...this.#waiters]) {
      if (index < waiter.after || !waiter.predicate(value)) continue;
      clearTimeout(waiter.timer);
      this.#waiters.delete(waiter);
      waiter.resolve(value);
    }
  }

  #fail(error: Error): void {
    if (this.#failure) return;
    this.#failure = error;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.#waiters.clear();
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGTERM");
  }
}
