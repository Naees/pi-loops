import { RpcWorkerClient, type RpcEnvelope } from "../../src/worker/rpc-client.ts";

export type { RpcEnvelope } from "../../src/worker/rpc-client.ts";

export interface RpcSpikeClientOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly requestTimeoutMs?: number;
  readonly maxLineBytes?: number;
  readonly maxStderrBytes?: number;
  readonly maxRetainedMessageBytes?: number;
}

export class RpcSpikeClient {
  readonly #client: RpcWorkerClient;

  constructor(executable: string, args: readonly string[], options: RpcSpikeClientOptions = {}) {
    this.#client = new RpcWorkerClient({
      executable,
      args,
      cwd: options.cwd ?? process.cwd(),
      environment: options.env ?? process.env,
      ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
      ...(options.maxLineBytes === undefined ? {} : { maxLineBytes: options.maxLineBytes }),
      ...(options.maxStderrBytes === undefined ? {} : { maxStderrBytes: options.maxStderrBytes }),
      ...(options.maxRetainedMessageBytes === undefined ? {} : { maxRetainedEventBytes: options.maxRetainedMessageBytes }),
    });
  }

  get child() {
    return this.#client.child;
  }

  get messages(): RpcEnvelope[] {
    return this.#client.events;
  }

  get exited() {
    return this.#client.exited;
  }

  get stderr(): string {
    return this.#client.stderrSummary;
  }

  checkpoint(): number {
    return this.#client.checkpoint();
  }

  send(command: Record<string, unknown>, signalOrTimeout?: AbortSignal | number): Promise<RpcEnvelope> {
    if (typeof signalOrTimeout !== "number") return this.#client.request(command, signalOrTimeout);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), signalOrTimeout);
    return this.#client.request(command, controller.signal).finally(() => clearTimeout(timer));
  }

  write(command: Record<string, unknown>): void {
    this.#client.write(command);
  }

  waitFor(
    predicate: (message: RpcEnvelope) => boolean,
    options: { after?: number; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<RpcEnvelope> {
    return this.#client.waitFor(predicate, options);
  }

  closeStdin(): void {
    this.#client.closeInput();
  }

  stop(_timeoutMs?: number) {
    return this.#client.stop();
  }
}
