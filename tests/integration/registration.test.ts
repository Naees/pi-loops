import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import piLoopsExtension from "../../src/extension/index.js";

const originalChildMarker = process.env.PI_LOOPS_CHILD;

afterEach(() => {
  if (originalChildMarker === undefined) {
    delete process.env.PI_LOOPS_CHILD;
  } else {
    process.env.PI_LOOPS_CHILD = originalChildMarker;
  }
});

function mockApi(): {
  api: ExtensionAPI;
  registerCommand: ReturnType<typeof vi.fn>;
  registerTool: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
} {
  const registerCommand = vi.fn();
  const registerTool = vi.fn();
  const on = vi.fn();
  return {
    api: { registerCommand, registerTool, on } as unknown as ExtensionAPI,
    registerCommand,
    registerTool,
    on,
  };
}

describe("Pi extension registration", () => {
  it("registers the namespaced command and tool in a parent process", () => {
    delete process.env.PI_LOOPS_CHILD;
    const { api, registerCommand, registerTool } = mockApi();

    piLoopsExtension(api);

    expect(registerCommand).toHaveBeenCalledWith("loops", expect.any(Object));
    expect(registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "pi_loops" }));
  });

  it("suppresses the outer controller in child worker mode", () => {
    process.env.PI_LOOPS_CHILD = "run_1234abcd";
    const { api, registerCommand, registerTool, on } = mockApi();

    piLoopsExtension(api);

    expect(registerCommand).not.toHaveBeenCalled();
    expect(registerTool).not.toHaveBeenCalled();
    expect(on).toHaveBeenCalledWith("session_start", expect.any(Function));
    expect(on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
  });
});
