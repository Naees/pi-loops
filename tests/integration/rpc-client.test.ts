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
  it("rejects invalid resource limits before spawning", () => {
    for (const [name, value] of [
      ["requestTimeoutMs", 0],
      ["maxLineBytes", -1],
      ["maxStderrBytes", 1.5],
      ["maxRetainedEventBytes", Number.POSITIVE_INFINITY],
      ["maxRetainedEvents", Number.NaN],
    ] as const) {
      expect(() => client(lineServer, { [name]: value })).toThrow(`${name} must be a positive safe integer`);
    }
  });

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

  it("cleans up timed-out and aborted requests without poisoning later correlation", async () => {
    const rpc = client(`let buffer = ""; let count = 0; process.stdin.setEncoding("utf8"); console.log(JSON.stringify({ type: "ready" })); process.stdin.on("data", chunk => { buffer += chunk; let newline; while ((newline = buffer.indexOf("\\n")) !== -1) { const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line) continue; const command = JSON.parse(line); count += 1; const respond = () => console.log(JSON.stringify({ type: "response", id: command.id, command: command.type, success: true })); if (count === 1 || command.type === "abort-late") setTimeout(respond, 250); else respond(); } });`, { requestTimeoutMs: 100 });
    try {
      await rpc.waitFor((event) => event.type === "ready", { timeoutMs: 5_000 });
      await expect(rpc.request({ type: "first" })).rejects.toThrow("timed out: first");
      await expect(rpc.request({ type: "second" })).resolves.toEqual(expect.objectContaining({ command: "second" }));
      await new Promise((resolve) => setTimeout(resolve, 300));
      await expect(rpc.request({ type: "third" })).resolves.toEqual(expect.objectContaining({ command: "third" }));

      const abort = new AbortController();
      abort.abort();
      await expect(rpc.request({ type: "never-written" }, abort.signal)).rejects.toMatchObject({ name: "AbortError" });

      const inFlightAbort = new AbortController();
      const aborted = rpc.request({ type: "abort-late" }, inFlightAbort.signal);
      inFlightAbort.abort();
      await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
      await expect(rpc.request({ type: "after-abort" })).resolves.toEqual(expect.objectContaining({ command: "after-abort" }));
      await new Promise((resolve) => setTimeout(resolve, 300));
      await expect(rpc.request({ type: "final" })).resolves.toEqual(expect.objectContaining({ command: "final" }));
    } finally {
      await rpc.stop();
    }
  });

  it("cleans up timed-out and aborted event waiters", async () => {
    const rpc = client(`setTimeout(() => console.log(JSON.stringify({ type: "ready" })), 80); process.stdin.resume();`);
    try {
      await expect(rpc.waitFor((event) => event.type === "ready", { timeoutMs: 20 })).rejects.toThrow("timed out");
      const abort = new AbortController();
      const aborted = rpc.waitFor(() => false, { timeoutMs: 1_000, signal: abort.signal });
      abort.abort();
      await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
      await expect(rpc.waitFor((event) => event.type === "ready", { timeoutMs: 200 })).resolves.toEqual({ type: "ready" });
    } finally {
      await rpc.stop();
    }
  });

  it("fails closed on malformed response envelopes", async () => {
    for (const response of [
      { type: "response", id: "pi_loops_1", command: "get_state" },
      { type: "response", id: "pi_loops_1", command: "get_state", success: "yes" },
      { type: "response", id: "pi_loops_1", success: true },
    ]) {
      const rpc = client(`process.stdin.once("data", () => console.log(${JSON.stringify(JSON.stringify(response))})); setInterval(() => {}, 1000);`);
      try {
        await expect(rpc.request({ type: "get_state" })).rejects.toThrow("invalid response envelope");
      } finally {
        await rpc.stop();
      }
    }
  });

  it("bounds event count and stderr output", async () => {
    const eventBound = client(`for (let i = 0; i < 3; i++) console.log(JSON.stringify({ type: "event", i })); setInterval(() => {}, 1000);`, { maxRetainedEvents: 2 });
    try {
      await expect(eventBound.waitFor(() => false, { timeoutMs: 5_000 })).rejects.toThrow("exceeds 2 retained events");
    } finally {
      await eventBound.stop();
    }

    const stderrBound = client(`process.stderr.write("x".repeat(1025)); setInterval(() => {}, 1000);`, { maxStderrBytes: 1024 });
    try {
      await expect(stderrBound.waitFor(() => false, { timeoutMs: 5_000 })).rejects.toThrow("stderr exceeds 1024 bytes");
      expect(Buffer.byteLength(stderrBound.stderrSummary, "utf8")).toBe(1024);
    } finally {
      await stderrBound.stop();
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
