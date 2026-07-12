import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RpcWorkerManager } from "../../src/worker/rpc-worker-manager.js";
import type { ParentWorkerUi } from "../../src/ui/worker-ui-relay.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function hostUi(): ParentWorkerUi {
  return {
    hasUI: true,
    confirm: vi.fn(async () => true),
    select: vi.fn(async () => undefined),
    input: vi.fn(async () => undefined),
    editor: vi.fn(async () => undefined),
    notify: vi.fn(),
  };
}

const fakeRpcProgram = `
const fs = require("node:fs");
const { spawn } = require("node:child_process");
let descendant;
fs.writeFileSync(process.env.PI_LOOPS_TEST_ARGV, JSON.stringify({ argv: process.argv, marker: process.env.PI_LOOPS_CHILD, deadline: process.env.PI_LOOPS_CHILD_DEADLINE_MS, pid: process.pid }));
let buffer = "";
let waitingUi = false;
const send = value => console.log(JSON.stringify(value));
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line) continue;
    const command = JSON.parse(line);
    if (command.type === "extension_ui_response") { waitingUi = false; send({ type: "agent_settled" }); continue; }
    if (command.type === "get_state") send({ type: "response", id: command.id, command: command.type, success: true, data: { isStreaming: false, sessionId: "session-1", sessionFile: process.env.PI_LOOPS_TEST_SESSION } });
    else if (command.type === "prompt") {
      send({ type: "response", id: command.id, command: command.type, success: true });
      send({ type: "agent_start" });
      if (command.message.includes("UI")) { waitingUi = true; send({ type: "extension_ui_request", id: "ui-1", method: "confirm", title: "Allow?", message: "Continue?" }); }
      else if (command.message.includes("DESCENDANT")) { descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); fs.writeFileSync(process.env.PI_LOOPS_TEST_DESCENDANT, String(descendant.pid)); }
      else send({ type: "agent_settled" });
    }
    else if (command.type === "get_last_assistant_text") send({ type: "response", id: command.id, command: command.type, success: true, data: { text: waitingUi ? null : "controlled result" } });
    else if (command.type === "abort") { if (descendant) descendant.kill("SIGTERM"); send({ type: "response", id: command.id, command: command.type, success: true }); }
  }
});
`;

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "pi-loops-worker-manager-"));
  const cwd = join(root, "worktree");
  const sessions = join(root, "sessions");
  const argvFile = join(root, "argv.json");
  const sessionFile = join(sessions, "session.jsonl");
  const descendantFile = join(root, "descendant.pid");
  temporaryDirectories.push(root);
  await import("node:fs/promises").then(({ mkdir }) => mkdir(cwd));
  const previousArgv = process.env.PI_LOOPS_TEST_ARGV;
  const previousSession = process.env.PI_LOOPS_TEST_SESSION;
  const previousDescendant = process.env.PI_LOOPS_TEST_DESCENDANT;
  process.env.PI_LOOPS_TEST_ARGV = argvFile;
  process.env.PI_LOOPS_TEST_SESSION = sessionFile;
  process.env.PI_LOOPS_TEST_DESCENDANT = descendantFile;
  const manager = new RpcWorkerManager({
    platform: "darwin",
    extensionPath: "/tmp/pi-loops-extension.ts",
    resolveLaunch: async () => ({
      executable: process.execPath,
      argsPrefix: ["-e", fakeRpcProgram, "--"],
      version: "0.80.6",
      source: "current-node-cli",
    }),
  });
  const restore = (): void => {
    if (previousArgv === undefined) delete process.env.PI_LOOPS_TEST_ARGV;
    else process.env.PI_LOOPS_TEST_ARGV = previousArgv;
    if (previousSession === undefined) delete process.env.PI_LOOPS_TEST_SESSION;
    else process.env.PI_LOOPS_TEST_SESSION = previousSession;
    if (previousDescendant === undefined) delete process.env.PI_LOOPS_TEST_DESCENDANT;
    else process.env.PI_LOOPS_TEST_DESCENDANT = previousDescendant;
  };
  return { manager, root, cwd, sessions, argvFile, sessionFile, descendantFile, restore };
}

function expectProcessGone(pid: number): void {
  expect(() => process.kill(pid, 0)).toThrow();
}

describe("RPC worker manager", () => {
  it("launches with bounded metadata and keeps prompts out of argv", async () => {
    const { manager, cwd, sessions, argvFile, restore } = await harness();
    try {
      const worker = await manager.launch({ runId: "run_1234abcd", cwd, sessionDirectory: sessions, absoluteDeadlineMs: Date.now() + 60_000 }, hostUi());
      const result = await worker.runCycle("SECRET_TASK_PROMPT");
      expect(result.lastAssistantText).toBe("controlled result");
      const launched = JSON.parse(await readFile(argvFile, "utf8")) as { argv: string[]; marker: string; deadline: string };
      expect(launched.argv.join(" ")).not.toContain("SECRET_TASK_PROMPT");
      expect(launched.marker).toMatch(/^[0-9a-f-]{36}$/);
      expect(Number(launched.deadline)).toBeGreaterThan(Date.now());
      await worker.stop();
    } finally {
      restore();
    }
  });

  it("resumes only the exact persisted session identity", async () => {
    const { manager, cwd, sessions, sessionFile, restore } = await harness();
    try {
      await mkdir(sessions, { recursive: true });
      await writeFile(sessionFile, "session\n");
      const worker = await manager.launch({
        runId: "run_1234abcd",
        cwd,
        sessionDirectory: sessions,
        absoluteDeadlineMs: Date.now() + 60_000,
        resume: { sessionId: "session-1", sessionFile },
      }, hostUi());
      await worker.stop();
      await expect(manager.launch({
        runId: "run_1234abcd",
        cwd,
        sessionDirectory: sessions,
        absoluteDeadlineMs: Date.now() + 60_000,
        resume: { sessionId: "different-session", sessionFile },
      }, hostUi())).rejects.toThrow("different session identity");
    } finally {
      restore();
    }
  });

  it("stops a production-manager RPC child and its controlled descendant", async () => {
    const { manager, cwd, sessions, descendantFile, restore } = await harness();
    try {
      const worker = await manager.launch({ runId: "run_1234abcd", cwd, sessionDirectory: sessions, absoluteDeadlineMs: Date.now() + 60_000 }, hostUi());
      const cycle = worker.runCycle("START DESCENDANT").catch(() => undefined);
      let descendantPid = 0;
      await vi.waitFor(async () => {
        descendantPid = Number(await readFile(descendantFile, "utf8"));
        expect(descendantPid).toBeGreaterThan(0);
      });
      await worker.stop();
      await cycle;
      expectProcessGone(worker.identity.pid);
      await vi.waitFor(() => expectProcessGone(descendantPid));
    } finally {
      restore();
    }
  });

  it("relays interactive UI by ID", async () => {
    const { manager, cwd, sessions, restore } = await harness();
    const ui = hostUi();
    try {
      const worker = await manager.launch({ runId: "run_1234abcd", cwd, sessionDirectory: sessions, absoluteDeadlineMs: Date.now() + 60_000 }, ui);
      await expect(worker.runCycle("REQUEST UI")).resolves.toEqual(expect.objectContaining({ lastAssistantText: "controlled result" }));
      expect(ui.confirm).toHaveBeenCalledWith("Allow?", "Continue?");
      await worker.stop();
    } finally {
      restore();
    }
  });

  it("rejects relative and symlink-escaped session files", async () => {
    const relativeHarness = await harness();
    try {
      process.env.PI_LOOPS_TEST_SESSION = "relative-session.jsonl";
      await expect(relativeHarness.manager.launch({
        runId: "run_1234abcd",
        cwd: relativeHarness.cwd,
        sessionDirectory: relativeHarness.sessions,
        absoluteDeadlineMs: Date.now() + 60_000,
      }, hostUi())).rejects.toThrow("non-absolute session file");
      const launched = JSON.parse(await readFile(relativeHarness.argvFile, "utf8")) as { pid: number };
      expectProcessGone(launched.pid);
    } finally {
      relativeHarness.restore();
    }

    const symlinkHarness = await harness();
    try {
      await mkdir(symlinkHarness.sessions, { recursive: true });
      const outside = join(symlinkHarness.root, "outside-session.jsonl");
      await writeFile(outside, "outside\n");
      await symlink(outside, symlinkHarness.sessionFile);
      await expect(symlinkHarness.manager.launch({
        runId: "run_1234abcd",
        cwd: symlinkHarness.cwd,
        sessionDirectory: symlinkHarness.sessions,
        absoluteDeadlineMs: Date.now() + 60_000,
      }, hostUi())).rejects.toThrow("escapes its managed session directory");
      const launched = JSON.parse(await readFile(symlinkHarness.argvFile, "utf8")) as { pid: number };
      expectProcessGone(launched.pid);
    } finally {
      symlinkHarness.restore();
    }
  });

  it("fails closed on unsupported platforms", async () => {
    const manager = new RpcWorkerManager({ platform: "linux" });
    await expect(manager.launch({
      runId: "run_1234abcd",
      cwd: process.cwd(),
      sessionDirectory: join(process.cwd(), ".unused"),
      absoluteDeadlineMs: Date.now() + 60_000,
    }, hostUi())).rejects.toThrow("validated only on macOS");
  });
});
