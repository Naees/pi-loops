import { describe, expect, it } from "vitest";
import { parseTriggerEventPayload, TRIGGER_EVENT_NAME } from "../../src/triggers/event-bus.js";

describe("trigger event-bus contract", () => {
  it("uses a namespaced channel and accepts only identity metadata", () => {
    expect(TRIGGER_EVENT_NAME).toBe("pi-loops:trigger");
    expect(parseTriggerEventPayload({ schemaVersion: 1, triggerId: "trigger_1234abcd", eventId: "build-42" })).toEqual({
      schemaVersion: 1,
      triggerId: "trigger_1234abcd",
      eventId: "build-42",
    });
  });

  it.each([
    null,
    [],
    {},
    { schemaVersion: 2, triggerId: "trigger_1234abcd" },
    { schemaVersion: 1, triggerId: "../../escape" },
    { schemaVersion: 1, triggerId: "trigger_1234abcd", eventId: "" },
    { schemaVersion: 1, triggerId: "trigger_1234abcd", eventId: "x".repeat(129) },
    { schemaVersion: 1, triggerId: "trigger_1234abcd", goal: "injected goal" },
    { schemaVersion: 1, triggerId: "trigger_1234abcd", verifierCommands: ["rm -rf /"] },
  ])("rejects hostile or malformed payload %#", (payload) => {
    expect(() => parseTriggerEventPayload(payload)).toThrow("invalid payload");
  });
});
