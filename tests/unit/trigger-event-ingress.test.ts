import { describe, expect, it, vi } from "vitest";
import { TriggerEventIngress, type TriggerFireResult } from "../../src/triggers/event-ingress.js";

const triggerId = "trigger_1234abcd";

describe("trigger event ingress", () => {
  it("deduplicates accepted event IDs and permits retry after failure", async () => {
    const ingress = new TriggerEventIngress(() => new Date("2026-07-12T12:00:00.000Z"));
    const deliver = vi.fn(async (): Promise<TriggerFireResult> => "started");
    await expect(ingress.dispatch(triggerId, "event-1", deliver)).resolves.toBe("started");
    await expect(ingress.dispatch(triggerId, "event-1", deliver)).resolves.toBe("ignored");
    expect(deliver).toHaveBeenCalledOnce();

    const failure = vi.fn(async (): Promise<TriggerFireResult> => { throw new Error("delivery failed"); });
    await expect(ingress.dispatch("trigger_deadbeef", "retry", failure)).rejects.toThrow("delivery failed");
    await expect(ingress.dispatch("trigger_deadbeef", "retry", failure)).rejects.toThrow("delivery failed");
    expect(failure).toHaveBeenCalledTimes(2);
  });

  it("expires debounce windows at the exact boundary and resets through forget and clear", async () => {
    let nowMs = Date.parse("2026-07-12T12:00:00.000Z");
    const ingress = new TriggerEventIngress(() => new Date(nowMs));
    const deliver = vi.fn(async (): Promise<TriggerFireResult> => "started");
    await expect(ingress.dispatch(triggerId, undefined, deliver)).resolves.toBe("started");
    await expect(ingress.dispatch(triggerId, undefined, deliver)).resolves.toBe("started");
    await expect(ingress.dispatch(triggerId, undefined, deliver)).resolves.toBe("coalesced");
    expect(deliver).toHaveBeenCalledTimes(2);

    nowMs += 250;
    await expect(ingress.dispatch(triggerId, undefined, deliver)).resolves.toBe("started");
    ingress.forget(triggerId);
    await expect(ingress.dispatch(triggerId, "repeat", deliver)).resolves.toBe("started");
    await expect(ingress.dispatch(triggerId, "repeat", deliver)).resolves.toBe("ignored");
    ingress.clear();
    await expect(ingress.dispatch(triggerId, "repeat", deliver)).resolves.toBe("started");
  });

  it("evicts only the oldest event ID after the bounded history is full", async () => {
    let nowMs = Date.parse("2026-07-12T12:00:00.000Z");
    const ingress = new TriggerEventIngress(() => new Date(nowMs));
    const deliver = vi.fn(async (): Promise<TriggerFireResult> => "started");
    for (let index = 0; index < 129; index += 1) {
      await ingress.dispatch(triggerId, `event-${index}`, deliver);
      nowMs += 250;
    }
    await expect(ingress.dispatch(triggerId, "event-128", deliver)).resolves.toBe("ignored");
    await expect(ingress.dispatch(triggerId, "event-0", deliver)).resolves.toBe("started");
    expect(deliver).toHaveBeenCalledTimes(130);
  });

  it("admits at most one pending delivery during a burst", async () => {
    const ingress = new TriggerEventIngress(() => new Date("2026-07-12T12:00:00.000Z"));
    let release: (() => void) | undefined;
    const deliver = vi.fn(async (): Promise<TriggerFireResult> => {
      if (deliver.mock.calls.length === 1) await new Promise<void>((resolve) => { release = resolve; });
      return deliver.mock.calls.length === 1 ? "started" : "coalesced";
    });
    const first = ingress.dispatch(triggerId, undefined, deliver);
    const burst = await Promise.all(Array.from({ length: 20 }, () => ingress.dispatch(triggerId, undefined, deliver)));
    expect(burst.every((result) => result === "coalesced")).toBe(true);
    release?.();
    await expect(first).resolves.toBe("started");
    expect(deliver).toHaveBeenCalledTimes(2);
  });
});
