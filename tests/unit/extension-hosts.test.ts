import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createGoalHost, createUnattendedHost } from "../../src/extension/hosts.js";
import type { RunRecord } from "../../src/shared/types.js";

function run(runId = "run_1234abcd"): RunRecord {
  return {
    runId,
    state: "interrupted",
    cycle: 2,
    totalCycles: 3,
    updatedAt: "2026-07-12T12:00:00.000Z",
    goal: "finish work",
  } as unknown as RunRecord;
}

function fixture(hasUI = true) {
  const sendUserMessage = vi.fn();
  const appendEntry = vi.fn();
  const abort = vi.fn();
  const ui = {
    notify: vi.fn((_message: string, _level: string) => undefined),
    select: vi.fn(async (_title: string, _options: string[]) => "run_deadbeef  interrupted  second"),
    confirm: vi.fn(async (_title: string, _message: string) => true),
    input: vi.fn(async (_title: string, _placeholder?: string) => "input"),
    editor: vi.fn(async (_title: string, _prefill?: string) => "edited"),
  };
  const pi = { sendUserMessage, appendEntry } as unknown as ExtensionAPI;
  const ctx = {
    cwd: "/tmp/project",
    hasUI,
    isIdle: () => false,
    abort,
    ui,
  } as unknown as ExtensionContext;
  return { pi, ctx, sendUserMessage, appendEntry, abort, ui };
}

describe("extension host adapters", () => {
  it("forwards goal work, status entries, cancellation, and UI selection", async () => {
    const { pi, ctx, sendUserMessage, appendEntry, abort, ui } = fixture();
    const host = createGoalHost(pi, ctx);
    expect(host.cwd).toBe("/tmp/project");
    expect(host.isIdle).toBe(false);

    host.sendWork("now", "immediate");
    host.sendWork("later", "followUp");
    expect(sendUserMessage).toHaveBeenNthCalledWith(1, "now");
    expect(sendUserMessage).toHaveBeenNthCalledWith(2, "later", { deliverAs: "followUp" });
    host.notify("notice", "warning");
    expect(ui.notify).toHaveBeenCalledWith("notice", "warning");
    host.appendRunEntry(run());
    expect(appendEntry).toHaveBeenCalledWith("pi-loops.run", {
      schemaVersion: 1,
      runId: "run_1234abcd",
      state: "interrupted",
      cycle: 2,
      totalCycles: 3,
      updatedAt: "2026-07-12T12:00:00.000Z",
    });
    host.abortAgent();
    expect(abort).toHaveBeenCalledOnce();
    await expect(host.selectRun?.([run(), run("run_deadbeef")])).resolves.toBe("run_deadbeef");
  });

  it("does not open a selector when no interactive UI exists", async () => {
    const { pi, ctx, ui } = fixture(false);
    const host = createGoalHost(pi, ctx);
    await expect(host.selectRun?.([run()])).resolves.toBeUndefined();
    expect(ui.select).not.toHaveBeenCalled();
  });

  it("forwards unattended UI methods without exposing readonly option arrays", async () => {
    const { pi, ctx, appendEntry, ui } = fixture();
    const host = createUnattendedHost(pi, ctx);
    const options = Object.freeze(["one", "two"]);

    await expect(host.ui.confirm("confirm", "message")).resolves.toBe(true);
    await expect(host.ui.select("select", options)).resolves.toBe("run_deadbeef  interrupted  second");
    await expect(host.ui.input("input", "placeholder")).resolves.toBe("input");
    await expect(host.ui.editor("editor", "prefill")).resolves.toBe("edited");
    host.ui.notify("ui notice", "info");
    host.notify("host notice", "error");
    expect(ui.select.mock.calls[0]?.[1]).toEqual(options);
    expect(ui.select.mock.calls[0]?.[1]).not.toBe(options);
    expect(ui.notify).toHaveBeenCalledWith("ui notice", "info");
    expect(ui.notify).toHaveBeenCalledWith("host notice", "error");
    host.appendRunEntry(run());
    expect(appendEntry).toHaveBeenCalledWith("pi-loops.run", expect.objectContaining({ runId: "run_1234abcd" }));
  });
});
