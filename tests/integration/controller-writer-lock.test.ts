import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveProjectBinding } from "../../src/contracts/project-binding.js";
import {
  acquireControllerWriterLock,
  releaseControllerWriterLock,
  repositoryWriterLeasePath,
  resolveGlobalRepositoryLockRoot,
  resolveRepositoryLockIdentity,
  type ControllerWriterLock,
} from "../../src/storage/controller-writer-lock.js";
import { acquireWriterLease, LeaseUnavailableError, releaseWriterLease } from "../../src/storage/lease.js";
import { writerLeasePath } from "../../src/storage/run-store.js";

const temporaryDirectories: string[] = [];
const activeLocks: ControllerWriterLock[] = [];
const fixture = join(process.cwd(), "scripts", "fixtures", "hold-writer-lock.mjs");

afterEach(async () => {
  await Promise.all(activeLocks.splice(0).map((lock) => releaseControllerWriterLock(lock).catch(() => undefined)));
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8", shell: false });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "pi-loops-writer-identity-"));
  temporaryDirectories.push(root);
  const repositoryRoot = join(root, "repository");
  const linkedWorktree = join(root, "linked-worktree");
  git(root, ["init", "-q", repositoryRoot]);
  await writeFile(join(repositoryRoot, "README.md"), "initial\n");
  git(repositoryRoot, ["add", "README.md"]);
  git(repositoryRoot, ["-c", "user.name=Pi Loops Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial"]);
  await mkdir(join(repositoryRoot, "nested"));
  git(repositoryRoot, ["worktree", "add", "-q", "-b", "linked-test", linkedWorktree]);
  return { root, repositoryRoot: await realpath(repositoryRoot), linkedWorktree: await realpath(linkedWorktree) };
}

function waitForReady(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      operation();
    };
    const timer = setTimeout(() => finish(() => reject(new Error("Lock fixture did not become ready"))), 5_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (output.includes("ready\n")) finish(resolve);
    });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("exit", (code) => {
      if (!output.includes("ready\n")) finish(() => reject(new Error(`Lock fixture exited before ready: ${code}`)));
    });
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Lock fixture did not exit"));
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

describe("controller repository writer lock", () => {
  it("uses one canonical identity for a root, nested directory, symlink, and linked worktree", async () => {
    const { root, repositoryRoot, linkedWorktree } = await repository();
    const alias = join(root, "repository-alias");
    await symlink(repositoryRoot, alias);
    const identities = await Promise.all([
      resolveRepositoryLockIdentity(repositoryRoot),
      resolveRepositoryLockIdentity(join(repositoryRoot, "nested")),
      resolveRepositoryLockIdentity(alias),
      resolveRepositoryLockIdentity(linkedWorktree),
    ]);

    expect(identities.every((identity) => identity.kind === "git")).toBe(true);
    expect(new Set(identities.map((identity) => identity.kind === "git" ? identity.commonGitDirectory : "non-git")).size).toBe(1);
    expect((await resolveProjectBinding(repositoryRoot)).projectId).not.toBe((await resolveProjectBinding(linkedWorktree)).projectId);
  });

  it("keeps non-Git projects functional and fails closed when Git cannot execute", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-loops-non-git-"));
    temporaryDirectories.push(directory);
    await expect(resolveRepositoryLockIdentity(directory)).resolves.toEqual({ kind: "non-git" });
    await expect(resolveRepositoryLockIdentity(directory, { executable: join(directory, "missing-git") }))
      .rejects.toThrow("Could not resolve Git repository identity");
  });

  it("sanitizes repository-shaping Git variables", async () => {
    const { repositoryRoot, linkedWorktree } = await repository();
    const expected = await resolveRepositoryLockIdentity(repositoryRoot);
    await expect(resolveRepositoryLockIdentity(repositoryRoot, {
      environment: { ...process.env, GIT_DIR: join(linkedWorktree, ".git"), GIT_WORK_TREE: linkedWorktree },
    })).resolves.toEqual(expected);
  });

  it("hashes repository paths and excludes aliases in-process", async () => {
    const { root, repositoryRoot, linkedWorktree } = await repository();
    const dataRoot = join(root, "data");
    const rootBinding = await resolveProjectBinding(repositoryRoot);
    const linkedBinding = await resolveProjectBinding(linkedWorktree);
    const identity = await resolveRepositoryLockIdentity(repositoryRoot);
    if (identity.kind !== "git") throw new Error("Expected Git identity");
    const path = repositoryWriterLeasePath(dataRoot, identity.commonGitDirectory);
    expect(path).not.toContain(identity.commonGitDirectory);
    expect(path.startsWith(`${dataRoot}/`)).toBe(true);
    expect(path).toMatch(/[0-9a-f]{64}\.lease\.json$/);

    const first = await acquireControllerWriterLock(dataRoot, rootBinding, 30_000, new Date(), dataRoot);
    activeLocks.push(first);
    await expect(acquireControllerWriterLock(dataRoot, linkedBinding, 30_000, new Date(), dataRoot)).rejects.toBeInstanceOf(LeaseUnavailableError);
    await releaseControllerWriterLock(first);
    activeLocks.splice(activeLocks.indexOf(first), 1);
    const second = await acquireControllerWriterLock(dataRoot, linkedBinding, 30_000, new Date(), dataRoot);
    activeLocks.push(second);
  });

  it("rejects relative lock identities and invalid Git timeouts", async () => {
    expect(() => repositoryWriterLeasePath("relative-root", "/tmp/repository/.git")).toThrow("lock root must be absolute");
    expect(() => repositoryWriterLeasePath("/tmp/locks", "relative-git-directory")).toThrow("common directory must be absolute");
    const directory = await mkdtemp(join(tmpdir(), "pi-loops-invalid-timeout-"));
    temporaryDirectories.push(directory);
    for (const timeoutMs of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
      await expect(resolveRepositoryLockIdentity(directory, { timeoutMs })).rejects.toThrow("positive safe integer");
    }
  });

  it("derives its global namespace independently of PI_CODING_AGENT_DIR", () => {
    const original = process.env.PI_CODING_AGENT_DIR;
    try {
      process.env.PI_CODING_AGENT_DIR = "/tmp/pi-profile-a";
      const first = resolveGlobalRepositoryLockRoot();
      process.env.PI_CODING_AGENT_DIR = "/tmp/pi-profile-b";
      expect(resolveGlobalRepositoryLockRoot()).toBe(first);
    } finally {
      if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = original;
    }
  });

  it("coordinates repository writers across different Pi data roots", async () => {
    const { root, repositoryRoot, linkedWorktree } = await repository();
    const lockRoot = join(root, "user-global-locks");
    const first = await acquireControllerWriterLock(
      join(root, "pi-data-a"),
      await resolveProjectBinding(repositoryRoot),
      30_000,
      new Date(),
      lockRoot,
    );
    activeLocks.push(first);

    await expect(acquireControllerWriterLock(
      join(root, "pi-data-b"),
      await resolveProjectBinding(linkedWorktree),
      30_000,
      new Date(),
      lockRoot,
    )).rejects.toBeInstanceOf(LeaseUnavailableError);
    expect(resolveGlobalRepositoryLockRoot().endsWith(join(".pi", "agent", "pi-loops", "repository-writer-locks"))).toBe(true);
  });

  it("releases the repository guard when project-store acquisition fails", async () => {
    const { root, repositoryRoot } = await repository();
    const dataRoot = join(root, "data");
    const binding = await resolveProjectBinding(repositoryRoot);
    const identity = await resolveRepositoryLockIdentity(repositoryRoot);
    if (identity.kind !== "git") throw new Error("Expected Git identity");
    const projectLease = await acquireWriterLease(writerLeasePath(dataRoot, binding.projectId), 30_000);
    try {
      await expect(acquireControllerWriterLock(dataRoot, binding, 30_000, new Date(), dataRoot)).rejects.toBeInstanceOf(LeaseUnavailableError);
      const repositoryLease = await acquireWriterLease(repositoryWriterLeasePath(dataRoot, identity.commonGitDirectory), 30_000);
      await releaseWriterLease(repositoryLease);
    } finally {
      await releaseWriterLease(projectLease);
    }
  });

  it("excludes a writer lock held by another process", async () => {
    const { root, repositoryRoot, linkedWorktree } = await repository();
    const lockRoot = join(root, "user-global-locks");
    const identity = await resolveRepositoryLockIdentity(repositoryRoot);
    if (identity.kind !== "git") throw new Error("Expected Git identity");
    const path = repositoryWriterLeasePath(lockRoot, identity.commonGitDirectory);
    await mkdir(dirname(path), { recursive: true });
    const child = spawn(process.execPath, [fixture, path], { stdio: ["pipe", "pipe", "pipe"] });
    try {
      await waitForReady(child);
      await expect(acquireControllerWriterLock(
        join(root, "different-pi-data-root"),
        await resolveProjectBinding(linkedWorktree),
        30_000,
        new Date(),
        lockRoot,
      ))
        .rejects.toBeInstanceOf(LeaseUnavailableError);
    } finally {
      child.stdin.end();
      await waitForExit(child);
    }
  });
});
