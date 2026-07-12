import { describe, expect, it } from "vitest";
import { AsyncSerialQueue } from "../../src/shared/async-queue.js";

describe("async serial queue", () => {
  it("runs operations in order and continues after rejection", async () => {
    const queue = new AsyncSerialQueue();
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.run(async () => {
      events.push("first:start");
      await firstGate;
      events.push("first:end");
      throw new Error("expected failure");
    });
    const second = queue.run(async () => {
      events.push("second");
      return 2;
    });

    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    releaseFirst?.();
    await expect(first).rejects.toThrow("expected failure");
    await expect(second).resolves.toBe(2);
    expect(events).toEqual(["first:start", "first:end", "second"]);
  });
});
