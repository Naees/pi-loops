import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { RpcJsonlDecoder } from "./rpc-jsonl.js";

export interface RpcWorkerClientOptions {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly requestTimeoutMs?: number;
  readonly maxLineBytes?: number;
  readonly maxStderrBytes?: number;
  readonly maxRetainedEventBytes?: number;
  readonly maxRetainedEvents?: number;
}

export interface RpcEnvelope extends Record<string, unknown> {
  readonly type: string;
  readonly id?: string;
}

interface PendingRequest {
  readonly command: string;
  readonly timer: NodeJS.Timeout;
  readonly resolve: (response: RpcEnvelope) => void;
  readonly reject: (error: Error) => void;
}

interface EventWaiter {
  readonly after: number;
  readonly predicate: (event: RpcEnvelope) => boolean;
  readonly timer: NodeJS.Timeout;
  readonly resolve: (event: RpcEnvelope) => void;
  readonly reject: (error: Error) => void;
}

function positive(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new Error(`${name} must be a positive safe integer`);
  return resolved;
}

function isEnvelope(value: unknown): value is RpcEnvelope {
  return typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as Record<string, unknown>).type === "string";
}

export class RpcWorkerClient {
  readonly child: ChildProcessWithoutNullStreams;
  readonly events: RpcEnvelope[] = [];
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  readonly #requestTimeoutMs: number;
  readonly #maxStderrBytes: number;
  readonly #maxRetainedEventBytes: number;
  readonly #maxRetainedEvents: number;
  #stderr = "";
  #eventBytes = 0;
  #sequence = 0;
  #inputClosed = false;
  #failure: Error | undefined;
  #pending = new Map<string, PendingRequest>();
  #waiters = new Set<EventWaiter>();
  #stopPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;

  constructor(options: RpcWorkerClientOptions) {
    this.#requestTimeoutMs = positive(options.requestTimeoutMs, 30_000, "requestTimeoutMs");
    this.#maxStderrBytes = positive(options.maxStderrBytes, 64 * 1024, "maxStderrBytes");
    this.#maxRetainedEventBytes = positive(options.maxRetainedEventBytes, 8 * 1024 * 1024, "maxRetainedEventBytes");
    this.#maxRetainedEvents = positive(options.maxRetainedEvents, 10_000, "maxRetainedEvents");
    const decoder = new RpcJsonlDecoder({ maxLineBytes: positive(options.maxLineBytes, 1024 * 1024, "maxLineBytes") });
    this.child = spawn(options.executable, [...options.args], {
      cwd: options.cwd,
      env: options.environment,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.exited = new Promise((resolve) => this.child.once("exit", (code, signal) => resolve({ code, signal })));

    this.child.stdout.on("data", (chunk: Buffer) => {
      if (this.#failure) return;
      try {
        for (const value of decoder.push(chunk)) this.#handle(value);
      } catch (error) {
        this.#fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    this.child.stdout.on("end", () => {
      if (this.#failure) return;
      try {
        for (const value of decoder.finish()) this.#handle(value);
      } catch (error) {
        this.#fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      if (this.#failure) return;
      const combined = Buffer.concat([Buffer.from(this.#stderr, "utf8"), chunk]);
      if (combined.byteLength > this.#maxStderrBytes) {
        this.#stderr = combined.subarray(combined.byteLength - this.#maxStderrBytes).toString("utf8");
        this.#fail(new Error(`RPC worker stderr exceeds ${this.#maxStderrBytes} bytes`));
        return;
      }
      this.#stderr = combined.toString("utf8");
    });
    this.child.once("error", (error) => this.#fail(error));
    this.child.stdin.on("error", (error) => this.#fail(error));
    void this.exited.then(({ code, signal }) => {
      if (!this.#failure && (this.#pending.size > 0 || this.#waiters.size > 0)) {
        this.#fail(new Error(`RPC worker exited unexpectedly: ${JSON.stringify({ code, signal })}`));
      }
    });
  }

  get pid(): number {
    const pid = this.child.pid;
    if (!pid) throw new Error("RPC worker has no process ID");
    return pid;
  }

  get stderrSummary(): string {
    return this.#stderr;
  }

  checkpoint(): number {
    return this.events.length;
  }

  write(command: Record<string, unknown>): void {
    if (this.#failure) throw this.#failure;
    if (this.#inputClosed || !this.child.stdin.writable) throw new Error("RPC worker input is closed");
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  request(command: Record<string, unknown>, signal?: AbortSignal): Promise<RpcEnvelope> {
    if (this.#failure) return Promise.reject(this.#failure);
    if (signal?.aborted) return Promise.reject(new DOMException("RPC request aborted", "AbortError"));
    const type = command.type;
    if (typeof type !== "string" || !type) return Promise.reject(new Error("RPC command requires a type"));
    const id = `pi_loops_${++this.#sequence}`;
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.#pending.delete(id);
        reject(new DOMException("RPC request aborted", "AbortError"));
      };
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        signal?.removeEventListener("abort", onAbort);
        reject(new Error(`RPC request timed out: ${type}`));
      }, this.#requestTimeoutMs);
      this.#pending.set(id, {
        command: type,
        timer,
        resolve: (response) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(response);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        this.write({ ...command, id });
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        signal?.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  waitFor(
    predicate: (event: RpcEnvelope) => boolean,
    options: { after?: number; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<RpcEnvelope> {
    const after = options.after ?? 0;
    const existing = this.events.slice(after).find(predicate);
    if (existing) return Promise.resolve(existing);
    if (this.#failure) return Promise.reject(this.#failure);
    if (options.signal?.aborted) return Promise.reject(new DOMException("RPC event wait aborted", "AbortError"));
    const timeoutMs = positive(options.timeoutMs, 60_000, "event timeout");
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        clearTimeout(waiter.timer);
        this.#waiters.delete(waiter);
        reject(new DOMException("RPC event wait aborted", "AbortError"));
      };
      const waiter: EventWaiter = {
        after,
        predicate,
        timer: setTimeout(() => {
          this.#waiters.delete(waiter);
          options.signal?.removeEventListener("abort", onAbort);
          reject(new Error(`RPC event timed out after ${timeoutMs}ms`));
        }, timeoutMs),
        resolve: (event) => {
          options.signal?.removeEventListener("abort", onAbort);
          resolve(event);
        },
        reject: (error) => {
          options.signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      };
      this.#waiters.add(waiter);
      options.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  closeInput(): void {
    if (this.#inputClosed) return;
    this.#inputClosed = true;
    this.child.stdin.end();
  }

  stop(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    this.#stopPromise ??= this.#stop();
    return this.#stopPromise;
  }

  async #stop(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return this.exited;
    const abortController = new AbortController();
    const abortTimer = setTimeout(() => abortController.abort(), 2_000);
    await this.request({ type: "abort" }, abortController.signal).catch(() => undefined);
    clearTimeout(abortTimer);
    this.closeInput();
    const graceful = await this.#waitForExit(2_000);
    if (graceful) return graceful;
    this.child.kill("SIGTERM");
    const terminated = await this.#waitForExit(2_000);
    if (terminated) return terminated;
    this.child.kill("SIGKILL");
    const forced = await this.#waitForExit(2_000);
    if (!forced) throw new Error("RPC worker survived SIGKILL");
    return forced;
  }

  async #waitForExit(timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null } | undefined> {
    return Promise.race([
      this.exited,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), timeoutMs)),
    ]);
  }

  #handle(value: unknown): void {
    if (this.#failure) return;
    if (!isEnvelope(value)) throw new Error("RPC worker emitted an invalid envelope");
    if (this.events.length >= this.#maxRetainedEvents) throw new Error(`RPC worker exceeds ${this.#maxRetainedEvents} retained events`);
    const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    if (this.#eventBytes + bytes > this.#maxRetainedEventBytes) {
      throw new Error(`RPC worker retained events exceed ${this.#maxRetainedEventBytes} bytes`);
    }
    this.#eventBytes += bytes;
    this.events.push(value);

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

    const index = this.events.length - 1;
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
