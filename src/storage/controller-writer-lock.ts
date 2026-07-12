import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import type { ProjectBinding } from "../contracts/project-binding.js";
import { sanitizedGitEnvironment } from "../worker/git-environment.js";
import {
  acquireWriterLease,
  assertWriterLeases,
  combineWriterLeaseSignals,
  releaseWriterLease,
  releaseWriterLeases,
  type WriterLease,
} from "./lease.js";
import { writerLeasePath } from "./run-store.js";

const GIT_IDENTITY_TIMEOUT_MS = 10_000;
const MAX_GIT_IDENTITY_BYTES = 64 * 1024;
const NOT_A_REPOSITORY = "fatal: not a git repository";

export type RepositoryLockIdentity =
  | { readonly kind: "git"; readonly commonGitDirectory: string }
  | { readonly kind: "non-git" };

export interface ControllerWriterLock {
  readonly identity: RepositoryLockIdentity;
  readonly projectLease: WriterLease;
  readonly repositoryLease?: WriterLease;
  readonly signal: AbortSignal;
}

export interface RepositoryIdentityOptions {
  readonly executable?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}

interface GitResult {
  readonly stdout: string;
  readonly nonGit: boolean;
}

function runGitIdentity(cwd: string, options: RepositoryIdentityOptions): Promise<GitResult> {
  const executable = options.executable ?? "git";
  const timeoutMs = options.timeoutMs ?? GIT_IDENTITY_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Git identity timeout must be a positive safe integer");
  return new Promise((resolveResult, rejectResult) => {
    execFile(executable, ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd,
      env: sanitizedGitEnvironment(options.environment),
      encoding: "utf8",
      maxBuffer: MAX_GIT_IDENTITY_BYTES,
      timeout: timeoutMs,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (!error) {
        resolveResult({ stdout, nonGit: false });
        return;
      }
      const exitCode = typeof error.code === "number" ? error.code : undefined;
      if (exitCode === 128 && stderr.trim().startsWith(NOT_A_REPOSITORY)) {
        resolveResult({ stdout: "", nonGit: true });
        return;
      }
      rejectResult(new Error(`Could not resolve Git repository identity: ${error.message}`));
    });
  });
}

export async function resolveRepositoryLockIdentity(
  cwd: string,
  options: RepositoryIdentityOptions = {},
): Promise<RepositoryLockIdentity> {
  const canonicalCwd = await realpath(cwd);
  const result = await runGitIdentity(canonicalCwd, options);
  if (result.nonGit) return { kind: "non-git" };
  const commonDirectory = result.stdout.trim();
  if (!isAbsolute(commonDirectory) || commonDirectory.includes("\n")) {
    throw new Error("Git returned an invalid common directory");
  }
  return { kind: "git", commonGitDirectory: await realpath(commonDirectory) };
}

export function resolveGlobalRepositoryLockRoot(): string {
  return join(userInfo().homedir, ".pi", "agent", "pi-loops", "repository-writer-locks");
}

export function repositoryWriterLeasePath(repositoryLockRoot: string, commonGitDirectory: string): string {
  if (!isAbsolute(repositoryLockRoot)) throw new Error("Repository lock root must be absolute");
  if (!isAbsolute(commonGitDirectory)) throw new Error("Git common directory must be absolute");
  const digest = createHash("sha256").update(commonGitDirectory).digest("hex");
  return join(repositoryLockRoot, `${digest}.lease.json`);
}

function sameIdentity(left: RepositoryLockIdentity, right: RepositoryLockIdentity): boolean {
  return left.kind === right.kind &&
    (left.kind === "non-git" || (right.kind === "git" && left.commonGitDirectory === right.commonGitDirectory));
}

export async function acquireControllerWriterLock(
  dataRoot: string,
  binding: ProjectBinding,
  staleMs: number,
  now: Date = new Date(),
  repositoryLockRoot: string = resolveGlobalRepositoryLockRoot(),
): Promise<ControllerWriterLock> {
  const identity = await resolveRepositoryLockIdentity(binding.projectRoot);
  let repositoryLease: WriterLease | undefined;
  let projectLease: WriterLease | undefined;
  try {
    if (identity.kind === "git") {
      repositoryLease = await acquireWriterLease(repositoryWriterLeasePath(repositoryLockRoot, identity.commonGitDirectory), staleMs, now);
    }
    projectLease = await acquireWriterLease(writerLeasePath(dataRoot, binding.projectId), staleMs, now);
    const confirmedIdentity = await resolveRepositoryLockIdentity(binding.projectRoot);
    if (!sameIdentity(identity, confirmedIdentity)) throw new Error("Repository identity changed while acquiring its writer lock");
    return {
      identity,
      projectLease,
      ...(repositoryLease === undefined ? {} : { repositoryLease }),
      signal: combineWriterLeaseSignals(repositoryLease === undefined ? [projectLease] : [repositoryLease, projectLease]),
    };
  } catch (error) {
    if (projectLease) await releaseWriterLease(projectLease).catch(() => undefined);
    if (repositoryLease) await releaseWriterLease(repositoryLease).catch(() => undefined);
    throw error;
  }
}

function controllerLeases(lock: ControllerWriterLock): WriterLease[] {
  return lock.repositoryLease === undefined ? [lock.projectLease] : [lock.repositoryLease, lock.projectLease];
}

export async function assertControllerWriterLock(lock: ControllerWriterLock): Promise<void> {
  await assertWriterLeases(controllerLeases(lock));
}

export async function releaseControllerWriterLock(lock: ControllerWriterLock): Promise<void> {
  await releaseWriterLeases(controllerLeases(lock));
}
