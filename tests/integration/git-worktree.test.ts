import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DirtyRepositoryError,
  GitWorktreeManager,
  ManagedWorktreeConflictError,
  WorktreeNeedsUserError,
} from "../../src/worker/git-worktree.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8", shell: false });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "pi-loops-worktree-"));
  temporaryDirectories.push(root);
  const repositoryRoot = join(root, "repository");
  const managedRoot = join(root, "managed worktrees");
  await rm(repositoryRoot, { recursive: true, force: true });
  git(root, ["init", "-q", repositoryRoot]);
  await writeFile(join(repositoryRoot, "README.md"), "# initial\n");
  git(repositoryRoot, ["add", "README.md"]);
  git(repositoryRoot, ["-c", "user.name=Pi Loops Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial"]);
  return { root, repositoryRoot, managedRoot, activeBranch: git(repositoryRoot, ["branch", "--show-current"]) };
}

describe("Git worktree manager", () => {
  it("creates an isolated review branch and finalizes without touching the active tree", async () => {
    const { repositoryRoot, managedRoot, activeBranch } = await repository();
    const manager = new GitWorktreeManager();
    const identity = await manager.inspectRepository(repositoryRoot);
    const worktree = await manager.create("run_1234abcd", identity, managedRoot);
    await writeFile(join(worktree.path, "result.txt"), "scheduled result\n");
    git(worktree.path, ["config", "user.name", "Pi Loops Test"]);
    git(worktree.path, ["config", "user.email", "test@example.invalid"]);

    const finalized = await manager.finalize(worktree, "Pi Loops run run_1234abcd");

    expect(finalized).toEqual(expect.objectContaining({ branch: "pi-loops/run_1234abcd", worktreeRemoved: true }));
    await expect(stat(worktree.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(git(repositoryRoot, ["branch", "--show-current"])).toBe(activeBranch);
    expect(await readFile(join(repositoryRoot, "README.md"), "utf8")).toBe("# initial\n");
    expect(git(repositoryRoot, ["show", `${finalized.branch}:result.txt`])).toBe("scheduled result");
  });

  it("rejects dirty source repositories and branch collisions", async () => {
    const { repositoryRoot, managedRoot } = await repository();
    const manager = new GitWorktreeManager();
    const identity = await manager.inspectRepository(repositoryRoot);
    await writeFile(join(repositoryRoot, "dirty.txt"), "dirty\n");
    await expect(manager.create("run_1234abcd", identity, managedRoot)).rejects.toBeInstanceOf(DirtyRepositoryError);
    await rm(join(repositoryRoot, "dirty.txt"));
    git(repositoryRoot, ["branch", "pi-loops/run_1234abcd"]);
    await expect(manager.create("run_1234abcd", identity, managedRoot)).rejects.toBeInstanceOf(ManagedWorktreeConflictError);
  });

  it("refuses to commit after the managed worktree changes branches", async () => {
    const { repositoryRoot, managedRoot } = await repository();
    const manager = new GitWorktreeManager();
    const worktree = await manager.create("run_1234abcd", await manager.inspectRepository(repositoryRoot), managedRoot);
    git(worktree.path, ["checkout", "-qb", "unexpected-branch"]);
    await writeFile(join(worktree.path, "result.txt"), "must not be committed\n");
    const headBefore = git(worktree.path, ["rev-parse", "HEAD"]);

    await expect(manager.commitReview(worktree, "scheduled result")).rejects.toThrow("branch identity changed");

    expect(git(worktree.path, ["rev-parse", "HEAD"])).toBe(headBefore);
    expect(git(worktree.path, ["status", "--porcelain"])).toContain("result.txt");
    expect(() => git(repositoryRoot, ["show", `${worktree.branch}:result.txt`])).toThrow();
  });

  it("never removes dirty unresolved worktrees", async () => {
    const { repositoryRoot, managedRoot } = await repository();
    const manager = new GitWorktreeManager();
    const worktree = await manager.create("run_1234abcd", await manager.inspectRepository(repositoryRoot), managedRoot);
    await writeFile(join(worktree.path, "unresolved.txt"), "keep me\n");

    await expect(manager.removeClean(worktree)).rejects.toBeInstanceOf(WorktreeNeedsUserError);
    expect(await readFile(join(worktree.path, "unresolved.txt"), "utf8")).toBe("keep me\n");
  });

  it("preserves worktrees when commit identity requires user action", async () => {
    const { repositoryRoot, managedRoot } = await repository();
    const manager = new GitWorktreeManager();
    const worktree = await manager.create("run_1234abcd", await manager.inspectRepository(repositoryRoot), managedRoot);
    await writeFile(join(worktree.path, "result.txt"), "result\n");
    git(worktree.path, ["config", "user.name", ""]);
    git(worktree.path, ["config", "user.email", ""]);

    await expect(manager.finalize(worktree, "scheduled result")).rejects.toBeInstanceOf(WorktreeNeedsUserError);
    expect(await readFile(join(worktree.path, "result.txt"), "utf8")).toBe("result\n");
  });
});
