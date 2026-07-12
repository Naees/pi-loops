import { describe, expect, it } from "vitest";
import { RpcJsonlDecoder, RpcProtocolError } from "../../src/worker/rpc-jsonl.js";

describe("RPC JSONL decoder", () => {
  it("decodes records across arbitrary byte chunks", () => {
    const decoder = new RpcJsonlDecoder();
    expect(decoder.push(Buffer.from('{"type":"res'))).toEqual([]);
    expect(decoder.push(Buffer.from('ponse","ok":true}\n{"value":2}\r'))).toEqual([
      { type: "response", ok: true },
    ]);
    expect(decoder.push(Buffer.from("\n"))).toEqual([{ value: 2 }]);
    expect(decoder.finish()).toEqual([]);
  });

  it("decodes the same stream at every deterministic chunk size", () => {
    const input = Buffer.from([
      JSON.stringify({ type: "one", text: "✅" }),
      JSON.stringify({ type: "two", value: 2 }),
      "",
    ].join("\n"));
    for (let chunkSize = 1; chunkSize <= input.byteLength; chunkSize += 1) {
      const decoder = new RpcJsonlDecoder();
      const values: unknown[] = [];
      for (let offset = 0; offset < input.byteLength; offset += chunkSize) {
        values.push(...decoder.push(input.subarray(offset, offset + chunkSize)));
      }
      values.push(...decoder.finish());
      expect(values, `chunk size ${chunkSize}`).toEqual([
        { type: "one", text: "✅" },
        { type: "two", value: 2 },
      ]);
    }
  });

  it("does not split JSON strings on Unicode line separators", () => {
    const decoder = new RpcJsonlDecoder();
    const input = `${JSON.stringify({ text: "before\u2028after\u2029done" })}\n`;
    expect(decoder.push(input)).toEqual([{ text: "before\u2028after\u2029done" }]);
  });

  it("preserves split multibyte UTF-8 characters", () => {
    const bytes = Buffer.from(`${JSON.stringify({ text: "✅" })}\n`);
    const split = bytes.indexOf(0xe2) + 1;
    const decoder = new RpcJsonlDecoder();
    expect(decoder.push(bytes.subarray(0, split))).toEqual([]);
    expect(decoder.push(bytes.subarray(split))).toEqual([{ text: "✅" }]);
  });

  it("rejects malformed and oversized records", () => {
    expect(() => new RpcJsonlDecoder({ maxLineBytes: 0 })).toThrow("positive safe integer");
    expect(() => new RpcJsonlDecoder({ maxLineBytes: 1.5 })).toThrow("positive safe integer");
    const malformed = new RpcJsonlDecoder();
    expect(() => malformed.push("not-json\n")).toThrow(RpcProtocolError);

    const oversized = new RpcJsonlDecoder({ maxLineBytes: 8 });
    expect(() => oversized.push('{"value":12345}')).toThrow("exceeds 8 bytes");
  });

  it("decodes a final record without a trailing newline", () => {
    const decoder = new RpcJsonlDecoder();
    decoder.push('{"done":true}');
    expect(decoder.finish()).toEqual([{ done: true }]);
  });
});
