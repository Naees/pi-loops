import { describe, expect, it, vi } from "vitest";
import { relayWorkerUiRequest, type ParentWorkerUi } from "../../src/ui/worker-ui-relay.js";

function ui(hasUI = true): ParentWorkerUi {
  return {
    hasUI,
    confirm: vi.fn(async () => true),
    select: vi.fn(async (_title, options) => options[0]),
    input: vi.fn(async () => "input"),
    editor: vi.fn(async () => "editor"),
    notify: vi.fn(),
  };
}

describe("worker UI relay", () => {
  it("relays confirmations by request ID", async () => {
    const host = ui();
    await expect(relayWorkerUiRequest({
      type: "extension_ui_request",
      id: "request-1",
      method: "confirm",
      title: "Allow?",
      message: "Continue?",
    }, host, new AbortController().signal)).resolves.toEqual({
      handled: true,
      response: { type: "extension_ui_response", id: "request-1", confirmed: true },
    });
  });

  it("never treats missing UI as approval", async () => {
    const host = ui(false);
    const result = await relayWorkerUiRequest({
      type: "extension_ui_request",
      id: "request-1",
      method: "confirm",
      title: "Allow?",
      message: "Continue?",
    }, host, new AbortController().signal);
    expect(result).toEqual({ handled: false, reason: "Worker requested interactive input without a parent UI" });
    expect(host.confirm).not.toHaveBeenCalled();
  });

  it("rejects unknown and malformed requests", async () => {
    const host = ui();
    await expect(relayWorkerUiRequest({ type: "extension_ui_request", id: "x", method: "custom" }, host, new AbortController().signal))
      .resolves.toEqual({ handled: false, reason: "Unsupported worker UI method: custom" });
    await expect(relayWorkerUiRequest({ type: "extension_ui_request", method: "confirm" }, host, new AbortController().signal))
      .resolves.toEqual({ handled: false, reason: "Malformed worker UI request" });
  });

  it.each([
    { method: "select", payload: { title: "Choose", options: ["first", "second"] }, expected: "first" },
    { method: "input", payload: { title: "Value", placeholder: "optional" }, expected: "input" },
    { method: "editor", payload: { title: "Edit", prefill: "initial" }, expected: "editor" },
  ])("relays $method responses", async ({ method, payload, expected }) => {
    const host = ui();
    await expect(relayWorkerUiRequest({
      type: "extension_ui_request",
      id: "request-1",
      method,
      ...payload,
    }, host, new AbortController().signal)).resolves.toEqual({
      handled: true,
      response: { type: "extension_ui_response", id: "request-1", value: expected },
    });
  });

  it("rejects oversized text and invalid select options", async () => {
    const host = ui();
    const oversized = "界".repeat(6_000);
    await expect(relayWorkerUiRequest({
      type: "extension_ui_request",
      id: "request-1",
      method: "confirm",
      title: oversized,
      message: "Continue?",
    }, host, new AbortController().signal)).resolves.toEqual({
      handled: false,
      reason: "Worker UI request contains invalid or oversized text",
    });
    for (const options of [[], Array.from({ length: 101 }, () => "option"), [1], [oversized]]) {
      await expect(relayWorkerUiRequest({
        type: "extension_ui_request",
        id: "request-1",
        method: "select",
        title: "Choose",
        options,
      }, host, new AbortController().signal)).resolves.toEqual({
        handled: false,
        reason: "Worker select request has invalid options",
      });
    }
  });

  it("fails closed when relay is aborted", async () => {
    const controller = new AbortController();
    const host = ui();
    host.confirm = vi.fn(() => new Promise<boolean>(() => undefined));
    const result = relayWorkerUiRequest({
      type: "extension_ui_request",
      id: "request-1",
      method: "confirm",
      title: "Allow?",
      message: "Continue?",
    }, host, controller.signal);
    controller.abort();
    await expect(result).resolves.toEqual({ handled: false, reason: "UI relay aborted" });
  });

  it("forwards fire-and-forget notifications without a UI", async () => {
    const host = ui(false);
    await expect(relayWorkerUiRequest({
      type: "extension_ui_request",
      id: "request-1",
      method: "notify",
      message: "worker notice",
      notifyType: "warning",
    }, host, new AbortController().signal)).resolves.toEqual({ handled: true });
    expect(host.notify).toHaveBeenCalledWith("worker notice", "warning");
  });
});
