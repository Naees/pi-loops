import { StringDecoder } from "node:string_decoder";

export class RpcProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RpcProtocolError";
  }
}

export interface RpcJsonlDecoderOptions {
  readonly maxLineBytes?: number;
}

export class RpcJsonlDecoder {
  readonly #decoder = new StringDecoder("utf8");
  readonly #maxLineBytes: number;
  #buffer = "";

  constructor(options: RpcJsonlDecoderOptions = {}) {
    this.#maxLineBytes = options.maxLineBytes ?? 1024 * 1024;
    if (!Number.isSafeInteger(this.#maxLineBytes) || this.#maxLineBytes <= 0) {
      throw new Error("maxLineBytes must be a positive safe integer");
    }
  }

  push(chunk: Uint8Array | string): unknown[] {
    this.#buffer += typeof chunk === "string" ? chunk : this.#decoder.write(Buffer.from(chunk));
    return this.#drain(false);
  }

  finish(): unknown[] {
    this.#buffer += this.#decoder.end();
    return this.#drain(true);
  }

  #drain(finishing: boolean): unknown[] {
    const values: unknown[] = [];

    while (true) {
      const newline = this.#buffer.indexOf("\n");
      if (newline === -1) break;

      let line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length === 0) continue;
      values.push(this.#parseLine(line));
    }

    if (Buffer.byteLength(this.#buffer, "utf8") > this.#maxLineBytes) {
      throw new RpcProtocolError(`RPC line exceeds ${this.#maxLineBytes} bytes`);
    }

    if (finishing && this.#buffer.length > 0) {
      const line = this.#buffer.endsWith("\r") ? this.#buffer.slice(0, -1) : this.#buffer;
      this.#buffer = "";
      if (line.length > 0) values.push(this.#parseLine(line));
    }

    return values;
  }

  #parseLine(line: string): unknown {
    if (Buffer.byteLength(line, "utf8") > this.#maxLineBytes) {
      throw new RpcProtocolError(`RPC line exceeds ${this.#maxLineBytes} bytes`);
    }

    try {
      return JSON.parse(line) as unknown;
    } catch (error) {
      throw new RpcProtocolError("Invalid JSON in RPC stream", { cause: error });
    }
  }
}
