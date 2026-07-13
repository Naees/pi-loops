import { describe, expect, it } from "vitest";
import { RpcSpikeClient } from "../../scripts/fixtures/rpc-spike-client.js";

describe("RPC spike client bounds", () => {
  it("fails before retaining unbounded aggregate stdout messages", async () => {
    const program = `const line = JSON.stringify({ type: "event", payload: "x".repeat(256 * 1024) }); for (let index = 0; index < 40; index += 1) console.log(line); setInterval(() => {}, 1000);`;
    const client = new RpcSpikeClient(process.execPath, ["-e", program]);

    try {
      await expect(client.waitFor(() => false, { timeoutMs: 10_000 })).rejects.toThrow("RPC worker retained events exceed 8388608 bytes");
      expect(client.messages.length).toBeLessThan(40);
    } finally {
      await client.stop();
    }
  });
});
