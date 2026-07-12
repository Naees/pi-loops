import { spawn } from "node:child_process";
import { mkdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isRunId } from "../shared/ids.js";

const GIT_TIMEOUT_MS = 30_000;
const MAX_GIT_OUTPUT_BYTES = 1024 * 1024;

export class GitCommandError extends Error {
  readonly args: readonly string[];
  readonly stderr: string;

  constructor(args: readonly string[], stderr: string) {
    super(`git ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`);
    this.name = "GitCommandError";
    this.args = args;
    this.stderr = stderr;
  }
}

export class NonGitRepositoryError extends Error {
  constructor(message = "Scheduled writing requires a Git repository") {
    super(message);
    this.name = "NonGitRepositoryError";
  }
}

export class DirtyRepositoryError extends Error {
  constructor(message = "Scheduled writing requires a clean Git working tree") {
    super(message);
    this.name = "DirtyRepositoryError";
  }
}

export class ManagedWorktreeConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagedWorktreeConflictError";
  }
}

export class WorktreeNeedsUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeNeedsUserError";
  }
}

export interface RepositoryIdentity {
  readonly repositoryRoot: string;
  readonly commonGitDirectory: string;
  readonly baseCommit: string;
}

export interface ManagedWorktree {
  readonly runId: string;
  readonly repositoryRoot: string;
  readonly branch: string;
  readonly path: string;
  readonly baseCommit: string;
}

export interface FinalizedReviewBranch {
  readonly branch: string;
  readonly commit: string;
  readonly worktreeRemoved: boolean;
}

async function runGit(args: readonly string[], cwd: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn("git", [...args], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      signal,
    });
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      operation();
    };
    const append = (current: Buffer, chunk: Buffer): Buffer => {
      const combined = Buffer.concat([current, chunk]);
      if (combined.byteLength > MAX_GIT_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(() => rejectCommand(new Error(`Git output exceeds ${MAX_GIT_OUTPUT_BYTES} bytes`)));
      }
      return combined.subarray(0, MAX_GIT_OUTPUT_BYTES);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.once("error", (error) => finish(() => rejectCommand(error)));
    child.once("exit", (code) => finish(() => {
      const errorText = stderr.toString("utf8").trim();
      if (code !== 0) rejectCommand(new GitCommandError(args, errorText));
      else resolveCommand(stdout.toString("utf8").trim());
    }));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => rejectCommand(new Error(`git ${args[0] ?? "command"} timed out after ${GIT_TIMEOUT_MS}ms`)));
    }, GIT_TIMEOUT_MS);
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function assertManagedPath(root: string, candidate: string): void {
  const relation = relative(root, candidate);
  if (relation.startsWith("..") || isAbsolute(relation) || relation === "") {
    throw new ManagedWorktreeConflictError("Managed worktree path escapes or equals its storage root");
  }
}

export class GitWorktreeManager {
  async inspectRepository(cwd: string, signal?: AbortSignal): Promise<RepositoryIdentity> {
    try {
      const repositoryRoot = await realpath(await runGit(["rev-parse", "--show-toplevel"], cwd, signal));
      const commonDirectoryOutput = await runGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], repositoryRoot, signal);
      const commonGitDirectory = await realpath(commonDirectoryOutput);
      const baseCommit = await runGit(["rev-parse", "HEAD"], repositoryRoot, signal);
      if (!/^[0-9a-f]{40,64}$/.test(baseCommit)) throw new NonGitRepositoryError("Git HEAD is not a commit");
      return { repositoryRoot, commonGitDirectory, baseCommit };
    } catch (error) {
      if (error instanceof GitCommandError) throw new NonGitRepositoryError(error.message);
      throw error;
    }
  }

  async requireCleanRepository(repositoryRoot: string, signal?: AbortSignal): Promise<void> {
    const status = await runGit(["status", "--porcelain=v1", "--untracked-files=normal"], repositoryRoot, signal);
    if (status.length > 0) throw new DirtyRepositoryError();
  }

  async create(runId: string, repository: RepositoryIdentity, managedRoot: string, signal?: AbortSignal): Promise<ManagedWorktree> {
    if (!isRunId(runId)) throw new Error(`Invalid run ID: ${runId}`);
    await this.requireCleanRepository(repository.repositoryRoot, signal);
    await mkdir(managedRoot, { recursive: true, mode: 0o700 });
    const canonicalManagedRoot = await realpath(managedRoot);
    const worktreePath = resolve(join(canonicalManagedRoot, runId));
    assertManagedPath(canonicalManagedRoot, worktreePath);
    const branch = `pi-loops/${runId}`;
    if (await pathExists(worktreePath)) throw new ManagedWorktreeConflictError(`Managed worktree already exists: ${worktreePath}`);
    const branchExists = await runGit(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], repository.repositoryRoot, signal)
      .then(() => true, (error: unknown) => {
        if (error instanceof GitCommandError) return false;
        throw error;
      });
    if (branchExists) throw new ManagedWorktreeConflictError(`Review branch already exists: ${branch}`);

    await runGit(["worktree", "add", "-b", branch, worktreePath, repository.baseCommit], repository.repositoryRoot, signal);
    const canonicalPath = await realpath(worktreePath);
    assertManagedPath(canonicalManagedRoot, canonicalPath);
    return { runId, repositoryRoot: repository.repositoryRoot, branch, path: canonicalPath, baseCommit: repository.baseCommit };
  }

  async commitReview(worktree: ManagedWorktree, commitMessage: string, signal?: AbortSignal): Promise<FinalizedReviewBranch> {
    const status = await runGit(["status", "--porcelain=v1", "--untracked-files=normal"], worktree.path, signal);
    if (!status) throw new WorktreeNeedsUserError("Scheduled run produced no reviewable changes");
    await runGit(["add", "--all"], worktree.path, signal);
    try {
      await runGit(["commit", "-m", commitMessage], worktree.path, signal);
    } catch (error) {
      throw new WorktreeNeedsUserError(error instanceof Error ? error.message : String(error));
    }
    const commit = await runGit(["rev-parse", "HEAD"], worktree.path, signal);
    return { branch: worktree.branch, commit, worktreeRemoved: false };
  }

  async finalize(worktree: ManagedWorktree, commitMessage: string, signal?: AbortSignal): Promise<FinalizedReviewBranch> {
    const committed = await this.commitReview(worktree, commitMessage, signal);
    await this.removeClean(worktree, signal);
    return { ...committed, worktreeRemoved: true };
  }

  async removeClean(worktree: ManagedWorktree, signal?: AbortSignal): Promise<void> {
    const currentBranch = await runGit(["branch", "--show-current"], worktree.path, signal);
    if (currentBranch !== worktree.branch) throw new WorktreeNeedsUserError("Managed worktree branch identity changed");
    const status = await runGit(["status", "--porcelain=v1", "--untracked-files=normal"], worktree.path, signal);
    if (status) throw new WorktreeNeedsUserError("Managed worktree is dirty and will not be removed");
    await runGit(["worktree", "remove", worktree.path], worktree.repositoryRoot, signal);
  }
}
