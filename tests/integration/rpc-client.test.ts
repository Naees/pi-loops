import { describe, expect, it } from "vitest";
import { RpcWorkerClient } from "../../src/worker/rpc-client.js";

function client(program: string, overrides: Partial<ConstructorParameters<typeof RpcWorkerClient>[0]> = {}): RpcWorkerClient {
  return new RpcWorkerClient({
    executable: process.execPath,
    args: ["-e", program],
    cwd: process.cwd(),
    environment: process.env,
    ...overrides,
  });
}

const lineServer = `let buffer = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", chunk => { buffer += chunk; let newline; while ((newline = buffer.indexOf("\\n")) !== -1) { const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line) continue; const command = JSON.parse(line); console.log(JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data: { ok: true } })); } });`;

describe("production RPC worker client", () => {
  it("correlates requests and stops idempotently", async () => {
    const rpc = client(lineServer);
    const response = await rpc.request({ type: "get_state" });
    expect(response).toEqual(expect.objectContaining({ command: "get_state", success: true }));

    const firstStop = rpc.stop();
    expect(rpc.stop()).toBe(firstStop);
    await expect(firstStop).resolves.toEqual(expect.objectContaining({ code: 0 }));
  });

  it("rejects response command mismatches", async () => {
    const rpc = client(`process.stdin.once("data", chunk => { const command = JSON.parse(chunk.toString()); console.log(JSON.stringify({ type: "response", id: command.id, command: "wrong", success: true })); }); setInterval(() => {}, 1000);`);
    try {
      await expect(rpc.request({ type: "get_state" })).rejects.toThrow("command mismatch");
    } finally {
      await rpc.stop();
    }
  });

  it("bounds aggregate retained events", async () => {
    const payload = "x".repeat(256 * 1024);
    const rpc = client(`const line = JSON.stringify({ type: "event", payload: ${JSON.stringify(payload)} }); for (let i = 0; i < 40; i++) console.log(line); setInterval(() => {}, 1000);`);
    try {
      await expect(rpc.waitFor(() => false, { timeoutMs: 10_000 })).rejects.toThrow("retained events exceed 8388608 bytes");
    } finally {
      await rpc.stop();
    }
  });

  it("rejects malformed or oversized protocol lines", async () => {
    const malformed = client(`console.log("not-json"); setInterval(() => {}, 1000);`);
    try {
      await expect(malformed.waitFor(() => false, { timeoutMs: 5_000 })).rejects.toThrow("Invalid JSON");
    } finally {
      await malformed.stop();
    }

    const oversized = client(`console.log(JSON.stringify({ type: "event", text: "x".repeat(2048) })); setInterval(() => {}, 1000);`, { maxLineBytes: 1024 });
    try {
      await expect(oversized.waitFor(() => false, { timeoutMs: 5_000 })).rejects.toThrow("exceeds 1024 bytes");
    } finally {
      await oversized.stop();
    }
  });
});
