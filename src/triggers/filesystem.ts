import { watch, type FSWatcher } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { TriggerRecord } from "../shared/types.js";

const MAX_WATCH_PATH_BYTES = 16 * 1024;
type WatchFunction = (
  path: string,
  options: { recursive: boolean },
  listener: (eventType: string, filename: string | Buffer | null) => void,
) => FSWatcher;

export interface ResolvedFilesystemTarget {
  readonly absolutePath: string;
  readonly relativePath: string;
}

function isContained(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

export async function resolveFilesystemTarget(projectRoot: string, input: string): Promise<ResolvedFilesystemTarget> {
  const value = input.trim().replace(/^@/, "");
  if (!value || value.includes("\0") || Buffer.byteLength(value, "utf8") > MAX_WATCH_PATH_BYTES) {
    throw new Error("Filesystem trigger path is empty, invalid, or oversized");
  }
  const canonicalProject = await realpath(projectRoot);
  const canonicalTarget = await realpath(resolve(canonicalProject, value));
  if (!isContained(canonicalProject, canonicalTarget)) throw new Error("Filesystem trigger path escapes its project");
  const relativePath = relative(canonicalProject, canonicalTarget) || ".";
  if (relativePath.split(/[\\/]/).includes(".git")) throw new Error("Filesystem triggers cannot watch Git metadata");
  return { absolutePath: canonicalTarget, relativePath };
}

interface ActiveWatch {
  readonly watcher: FSWatcher;
  readonly absolutePath: string;
  readonly device: bigint;
  readonly inode: bigint;
  readonly isDirectory: boolean;
  timer: NodeJS.Timeout | undefined;
}

export class FilesystemTriggerManager {
  readonly #active = new Map<string, ActiveWatch>();
  readonly #onTrigger: (triggerId: string) => Promise<void>;
  readonly #onError: (triggerId: string, error: unknown) => void;
  readonly #watch: WatchFunction;

  constructor(options: {
    onTrigger: (triggerId: string) => Promise<void>;
    onError: (triggerId: string, error: unknown) => void;
    watch?: WatchFunction;
  }) {
    this.#onTrigger = options.onTrigger;
    this.#onError = options.onError;
    this.#watch = options.watch ?? watch as WatchFunction;
  }

  async upsert(trigger: TriggerRecord): Promise<void> {
    this.remove(trigger.triggerId);
    if (trigger.source.kind !== "filesystem" || trigger.state === "paused") return;
    const target = await resolveFilesystemTarget(trigger.projectRoot, trigger.source.relativePath);
    const metadata = await stat(target.absolutePath, { bigint: true });
    const active: ActiveWatch = {
      absolutePath: target.absolutePath,
      device: metadata.dev,
      inode: metadata.ino,
      isDirectory: metadata.isDirectory(),
      timer: undefined,
      watcher: this.#watch(target.absolutePath, { recursive: metadata.isDirectory() }, (_eventType, filename) => {
        if (filename === null && active.isDirectory) return;
        const changedPath = filename?.toString() ?? "";
        if (changedPath.split(/[\\/]/).includes(".git")) return;
        this.#schedule(trigger, active);
      }),
    };
    active.watcher.on("error", (error) => this.#onError(trigger.triggerId, error));
    active.watcher.unref();
    this.#active.set(trigger.triggerId, active);
  }

  #schedule(trigger: TriggerRecord, active: ActiveWatch): void {
    if (active.timer) clearTimeout(active.timer);
    active.timer = setTimeout(() => {
      active.timer = undefined;
      void (async () => {
        if (this.#active.get(trigger.triggerId) !== active || !(await this.#isUnchanged(active))) return;
        await this.#onTrigger(trigger.triggerId);
      })().catch((error: unknown) => this.#onError(trigger.triggerId, error));
    }, trigger.source.kind === "filesystem" ? trigger.source.debounceMs : 1_000);
    active.timer.unref();
  }

  async #isUnchanged(active: ActiveWatch): Promise<boolean> {
    try {
      const [canonicalPath, metadata] = await Promise.all([
        realpath(active.absolutePath),
        stat(active.absolutePath, { bigint: true }),
      ]);
      return canonicalPath === active.absolutePath && metadata.dev === active.device && metadata.ino === active.inode;
    } catch {
      return false;
    }
  }

  remove(triggerId: string): void {
    const active = this.#active.get(triggerId);
    if (!active) return;
    if (active.timer) clearTimeout(active.timer);
    active.watcher.close();
    this.#active.delete(triggerId);
  }

  shutdown(): void {
    for (const triggerId of [...this.#active.keys()]) this.remove(triggerId);
  }
}
