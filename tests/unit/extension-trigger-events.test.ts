import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerTriggerEventRelay } from "../../src/extension/trigger-events.js";
import type { TriggerController } from "../../src/triggers/controller.js";

afterEach(() => vi.useRealTimers());

function context() {
  return {
    cwd: "/tmp/project",
    ui: { notify: vi.fn() },
  } as unknown as ExtensionContext;
}

describe("extension trigger event relay", () => {
  it("ignores inactive delivery and targets late failures to the originating context", async () => {
    let handler: ((payload: unknown) => void) | undefined;
    const api = { events: { on: vi.fn((_name, callback) => { handler = callback; return vi.fn(); }) } } as unknown as ExtensionAPI;
    let rejectDelivery: ((error: Error) => void) | undefined;
    const fireEvent = vi.fn(() => new Promise<"started">((_resolve, reject) => { rejectDelivery = reject; }));
    const relay = registerTriggerEventRelay(api, { fireEvent } as unknown as TriggerController);
    const first = context();
    const second = context();

    handler?.({ schemaVersion: 1, triggerId: "trigger_1234abcd" });
    expect(fireEvent).not.toHaveBeenCalled();
    relay.activate(first);
    handler?.({ schemaVersion: 1, triggerId: "trigger_1234abcd", eventId: "build-1" });
    expect(fireEvent).toHaveBeenCalledWith("trigger_1234abcd", "/tmp/project", "build-1");
    relay.deactivate();
    relay.activate(second);
    rejectDelivery?.(new Error("delivery failed"));
    await vi.waitFor(() => expect(first.ui.notify).toHaveBeenCalledWith(
      "Pi Loops trigger event failed: delivery failed",
      "error",
    ));
    expect(second.ui.notify).not.toHaveBeenCalled();
  });

  it("rate-limits malformed event notifications and reports suppressed errors later", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T12:00:00.000Z"));
    let handler: ((payload: unknown) => void) | undefined;
    const api = { events: { on: vi.fn((_name, callback) => { handler = callback; return vi.fn(); }) } } as unknown as ExtensionAPI;
    const current = context();
    const relay = registerTriggerEventRelay(api, { fireEvent: vi.fn() } as unknown as TriggerController);
    relay.activate(current);

    handler?.({ hostile: true });
    handler?.({ hostile: true });
    expect(current.ui.notify).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_000);
    handler?.({ hostile: true });
    expect(current.ui.notify).toHaveBeenLastCalledWith(
      "Pi Loops rejected trigger event: Pi Loops trigger event has an invalid payload (1 similar errors suppressed)",
      "error",
    );
    relay.deactivate();
    handler?.({ hostile: true });
    expect(current.ui.notify).toHaveBeenCalledTimes(2);
  });
});
