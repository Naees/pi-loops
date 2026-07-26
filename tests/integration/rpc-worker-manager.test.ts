import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  QUALIFIED_UNATTENDED_PLATFORMS,
  RpcWorkerManager,
  type RpcWorkerQualificationOptions,
} from "../../src/worker/rpc-worker-manager.js";
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

async function harness(options: {
  program?: string;
  version?: string;
  platform?: NodeJS.Platform;
  qualifiedPlatforms?: readonly NodeJS.Platform[];
  qualification?: RpcWorkerQualificationOptions;
} = {}) {
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
  const platform = options.platform ?? "darwin";
  const manager = new RpcWorkerManager({
    platform,
    qualifiedPlatforms: options.qualifiedPlatforms ?? [platform],
    extensionPath: "/tmp/pi-loops-extension.ts",
    resolveLaunch: async () => ({
      executable: process.execPath,
      argsPrefix: ["-e", options.program ?? fakeRpcProgram, "--"],
      version: options.version ?? "0.82.1",
      source: "current-node-cli",
    }),
    ...(options.qualification === undefined ? {} : { qualification: options.qualification }),
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

function handshakeProgram(data: string): string {
  return `
const fs = require("node:fs");
fs.writeFileSync(process.env.PI_LOOPS_TEST_ARGV, JSON.stringify({ pid: process.pid }));
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const command = JSON.parse(line);
    const response = { type: "response", id: command.id, command: command.type, success: true };
    if (command.type === "get_state") response.data = ${data};
    console.log(JSON.stringify(response));
  }
});
`;
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

  it("passes bounded native qualification arguments without shell interpolation", async () => {
    const qualificationExtension = join(process.cwd(), "scripts", "fixtures", "rpc-lifecycle-extension.ts");
    const { manager, cwd, sessions, argvFile, restore } = await harness({
      qualification: {
        extensionPaths: [qualificationExtension],
        provider: "test-provider",
        model: "test-model",
      },
    });
    try {
      const worker = await manager.launch({
        runId: "run_1234abcd",
        cwd,
        sessionDirectory: sessions,
        absoluteDeadlineMs: Date.now() + 60_000,
      }, hostUi());
      const launched = JSON.parse(await readFile(argvFile, "utf8")) as { argv: string[] };
      const extensionPaths = launched.argv.flatMap((argument, index) =>
        argument === "--extension" && launched.argv[index + 1] ? [launched.argv[index + 1] as string] : []);
      expect(extensionPaths).toEqual(["/tmp/pi-loops-extension.ts", qualificationExtension]);
      expect(launched.argv).toEqual(expect.arrayContaining([
        "--provider", "test-provider",
        "--model", "test-model",
      ]));
      await worker.stop();
    } finally {
      restore();
    }
  });

  it("rejects unbounded or ambiguous native qualification options", () => {
    const absoluteExtension = join(process.cwd(), "extension.ts");
    for (const qualification of [
      { extensionPaths: [], provider: "provider", model: "model" },
      { extensionPaths: Array.from({ length: 11 }, () => absoluteExtension), provider: "provider", model: "model" },
      { extensionPaths: ["relative.ts"], provider: "provider", model: "model" },
      { extensionPaths: [absoluteExtension], provider: " ", model: "model" },
      { extensionPaths: [absoluteExtension], provider: "provider", model: " " },
    ]) {
      expect(() => new RpcWorkerManager({ qualification })).toThrow("qualification options are invalid");
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
      }, { timeout: 10_000 });
      await worker.stop();
      await cycle;
      expectProcessGone(worker.identity.pid);
      await vi.waitFor(() => expectProcessGone(descendantPid), { timeout: 10_000 });
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

  it("rejects invalid deadlines and unvalidated Pi versions before accepting a worker", async () => {
    const resolveLaunch = vi.fn(async () => ({
      executable: process.execPath,
      argsPrefix: [] as string[],
      version: "0.82.1",
      source: "current-node-cli" as const,
    }));
    const manager = new RpcWorkerManager({ platform: "darwin", resolveLaunch });
    for (const absoluteDeadlineMs of [Date.now(), Date.now() - 1, 1.5, Number.POSITIVE_INFINITY]) {
      await expect(manager.launch({
        runId: "run_1234abcd",
        cwd: process.cwd(),
        sessionDirectory: join(process.cwd(), ".unused"),
        absoluteDeadlineMs,
      }, hostUi())).rejects.toThrow("future absolute deadline");
    }
    expect(resolveLaunch).not.toHaveBeenCalled();

    const mismatched = await harness({ version: "0.80.6" });
    try {
      await expect(mismatched.manager.launch({
        runId: "run_1234abcd",
        cwd: mismatched.cwd,
        sessionDirectory: mismatched.sessions,
        absoluteDeadlineMs: Date.now() + 60_000,
      }, hostUi())).rejects.toThrow("require validated Pi 0.82.1");
      await expect(readFile(mismatched.argvFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      mismatched.restore();
    }
  });

  it("rejects non-object response data after a settled worker cycle", async () => {
    const program = `
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line) continue;
    const command = JSON.parse(line);
    const response = { type: "response", id: command.id, command: command.type, success: true };
    if (command.type === "get_state") response.data = { isStreaming: false, sessionId: "session-1", sessionFile: process.env.PI_LOOPS_TEST_SESSION };
    if (command.type === "get_last_assistant_text") response.data = [];
    console.log(JSON.stringify(response));
    if (command.type === "prompt") console.log(JSON.stringify({ type: "agent_settled" }));
  }
});
`;
    const malformed = await harness({ program });
    try {
      const worker = await malformed.manager.launch({
        runId: "run_1234abcd",
        cwd: malformed.cwd,
        sessionDirectory: malformed.sessions,
        absoluteDeadlineMs: Date.now() + 60_000,
      }, hostUi());
      await expect(worker.runCycle("work")).rejects.toThrow("invalid response data");
      await worker.stop();
    } finally {
      malformed.restore();
    }
  });

  it("fails malformed handshakes closed and reaps every spawned worker", async () => {
    for (const [data, message] of [
      ['{ isStreaming: true, sessionId: "session-1", sessionFile: process.env.PI_LOOPS_TEST_SESSION }', "handshake is invalid"],
      ['{ isStreaming: false, sessionId: "", sessionFile: process.env.PI_LOOPS_TEST_SESSION }', "handshake is invalid"],
      ['{ isStreaming: false, sessionId: "session-1", sessionFile: 42 }', "handshake is invalid"],
    ] as const) {
      const malformed = await harness({ program: handshakeProgram(data) });
      try {
        await expect(malformed.manager.launch({
          runId: "run_1234abcd",
          cwd: malformed.cwd,
          sessionDirectory: malformed.sessions,
          absoluteDeadlineMs: Date.now() + 60_000,
        }, hostUi())).rejects.toThrow(message);
        const launched = JSON.parse(await readFile(malformed.argvFile, "utf8")) as { pid: number };
        expectProcessGone(launched.pid);
      } finally {
        malformed.restore();
      }
    }
  });

  it("requires reported and resumed sessions to be regular non-symlink files", async () => {
    const reportedDirectory = await harness();
    try {
      await mkdir(reportedDirectory.sessionFile, { recursive: true });
      await expect(reportedDirectory.manager.launch({
        runId: "run_1234abcd",
        cwd: reportedDirectory.cwd,
        sessionDirectory: reportedDirectory.sessions,
        absoluteDeadlineMs: Date.now() + 60_000,
      }, hostUi())).rejects.toThrow("must be a regular file");
      const launched = JSON.parse(await readFile(reportedDirectory.argvFile, "utf8")) as { pid: number };
      expectProcessGone(launched.pid);
    } finally {
      reportedDirectory.restore();
    }

    const resumedSymlink = await harness();
    try {
      await mkdir(resumedSymlink.sessions, { recursive: true });
      const actual = join(resumedSymlink.sessions, "actual.jsonl");
      const linked = join(resumedSymlink.sessions, "linked.jsonl");
      await writeFile(actual, "session\n");
      await symlink(actual, linked);
      await expect(resumedSymlink.manager.launch({
        runId: "run_1234abcd",
        cwd: resumedSymlink.cwd,
        sessionDirectory: resumedSymlink.sessions,
        absoluteDeadlineMs: Date.now() + 60_000,
        resume: { sessionId: "session-1", sessionFile: linked },
      }, hostUi())).rejects.toThrow("regular non-symlink file");
      await expect(readFile(resumedSymlink.argvFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      resumedSymlink.restore();
    }
  });

  it.each(["linux", "win32"] as const)("can exercise an explicitly isolated platform qualification override for %s", async (platform) => {
    const qualified = await harness({ platform, qualifiedPlatforms: [platform] });
    try {
      const worker = await qualified.manager.launch({
        runId: "run_1234abcd",
        cwd: qualified.cwd,
        sessionDirectory: qualified.sessions,
        absoluteDeadlineMs: Date.now() + 60_000,
      }, hostUi());
      await expect(worker.runCycle("qualification cycle")).resolves.toEqual(expect.objectContaining({ lastAssistantText: "controlled result" }));
      await worker.stop();
    } finally {
      qualified.restore();
    }
  });

  it("enables only the three independently qualified production platforms", async () => {
    expect(QUALIFIED_UNATTENDED_PLATFORMS).toEqual(["darwin", "linux", "win32"]);
    const platform: NodeJS.Platform = "freebsd";
    const manager = new RpcWorkerManager({ platform });
    await expect(manager.launch({
      runId: "run_1234abcd",
      cwd: process.cwd(),
      sessionDirectory: join(process.cwd(), ".unused"),
      absoluteDeadlineMs: Date.now() + 60_000,
    }, hostUi())).rejects.toThrow(`not qualified on ${platform}`);
  });
});
