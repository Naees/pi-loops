import { watch, type FSWatcher } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { TriggerRecord } from "../shared/types.js";

const MAX_WATCH_PATH_BYTES = 16 * 1024;
export type WatchFunction = (
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
  watcher: FSWatcher | undefined;
  readonly absolutePath: string;
  device: bigint;
  inode: bigint;
  readonly isDirectory: boolean;
  timer: NodeJS.Timeout | undefined;
}

interface TargetIdentity {
  readonly device: bigint;
  readonly inode: bigint;
  readonly isDirectory: boolean;
}

interface OpenedWatcher {
  readonly watcher: FSWatcher;
  readonly error: unknown;
}

export class FilesystemTriggerManager {
  readonly #active = new Map<string, ActiveWatch>();
  readonly #onTrigger: (triggerId: string) => Promise<void>;
  readonly #onError: (triggerId: string, error: unknown) => void | Promise<void>;
  readonly #watch: WatchFunction;

  constructor(options: {
    onTrigger: (triggerId: string) => Promise<void>;
    onError: (triggerId: string, error: unknown) => void | Promise<void>;
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
    const identity = await this.#readIdentity(target.absolutePath);
    const active: ActiveWatch = {
      absolutePath: target.absolutePath,
      device: identity.device,
      inode: identity.inode,
      isDirectory: identity.isDirectory,
      timer: undefined,
      watcher: undefined,
    };
    const opened = this.#openWatcher(trigger, active);
    active.watcher = opened.watcher;
    try {
      const confirmed = await this.#readIdentity(target.absolutePath, identity.isDirectory);
      if (confirmed.device !== identity.device || confirmed.inode !== identity.inode) {
        throw new Error(`Filesystem trigger target changed while its watcher was starting: ${trigger.triggerId}`);
      }
      if (opened.error !== undefined) throw opened.error;
    } catch (error) {
      opened.watcher.close();
      throw error;
    }
    this.#active.set(trigger.triggerId, active);
  }

  #openWatcher(trigger: TriggerRecord, active: ActiveWatch): OpenedWatcher {
    let openingError: unknown;
    let watcher!: FSWatcher;
    watcher = this.#watch(active.absolutePath, { recursive: active.isDirectory }, (_eventType, filename) => {
      if (active.watcher !== watcher) return;
      if (filename === null && active.isDirectory) return;
      const changedPath = filename?.toString() ?? "";
      if (changedPath.split(/[\\/]/).includes(".git")) return;
      this.#schedule(trigger, active);
    });
    watcher.on("error", (error) => {
      if (active.watcher === watcher && this.#active.get(trigger.triggerId) === active) {
        this.#fail(trigger.triggerId, active, error);
      } else {
        openingError = error;
        watcher.close();
      }
    });
    watcher.unref();
    return { watcher, get error() { return openingError; } };
  }

  #schedule(trigger: TriggerRecord, active: ActiveWatch): void {
    if (active.timer) clearTimeout(active.timer);
    active.timer = setTimeout(() => {
      active.timer = undefined;
      void (async () => {
        if (this.#active.get(trigger.triggerId) !== active) return;
        const identity = await this.#readIdentity(active.absolutePath, active.isDirectory);
        if (identity.device !== active.device || identity.inode !== active.inode) {
          await this.#rearm(trigger, active, identity);
        }
        if (this.#active.get(trigger.triggerId) !== active) return;
        await this.#onTrigger(trigger.triggerId);
      })().catch((error: unknown) => this.#fail(trigger.triggerId, active, error));
    }, trigger.source.kind === "filesystem" ? trigger.source.debounceMs : 1_000);
    active.timer.unref();
  }

  async #readIdentity(absolutePath: string, expectedDirectory?: boolean): Promise<TargetIdentity> {
    const canonicalPath = await realpath(absolutePath);
    if (canonicalPath !== absolutePath) throw new Error("Filesystem trigger target no longer resolves to its canonical project path");
    const metadata = await stat(absolutePath, { bigint: true });
    const isDirectory = metadata.isDirectory();
    if (expectedDirectory !== undefined && isDirectory !== expectedDirectory) {
      throw new Error("Filesystem trigger target changed between file and directory");
    }
    return { device: metadata.dev, inode: metadata.ino, isDirectory };
  }

  async #rearm(trigger: TriggerRecord, active: ActiveWatch, identity: TargetIdentity): Promise<void> {
    const replacement = this.#openWatcher(trigger, active);
    try {
      const confirmed = await this.#readIdentity(active.absolutePath, active.isDirectory);
      if (confirmed.device !== identity.device || confirmed.inode !== identity.inode) {
        throw new Error(`Filesystem trigger target changed while its watcher was re-arming: ${trigger.triggerId}`);
      }
      if (replacement.error !== undefined) throw replacement.error;
    } catch (error) {
      replacement.watcher.close();
      throw error;
    }
    const previous = active.watcher;
    active.watcher = replacement.watcher;
    active.device = identity.device;
    active.inode = identity.inode;
    previous?.close();
  }

  #fail(triggerId: string, active: ActiveWatch, error: unknown): void {
    if (this.#active.get(triggerId) !== active) return;
    this.remove(triggerId);
    try {
      const reported = this.#onError(triggerId, error);
      if (reported) void reported.catch(() => undefined);
    } catch {
      // A watcher has already been removed and cannot safely report a second failure through itself.
    }
  }

  remove(triggerId: string): void {
    const active = this.#active.get(triggerId);
    if (!active) return;
    if (active.timer) clearTimeout(active.timer);
    active.watcher?.close();
    this.#active.delete(triggerId);
  }

  shutdown(): void {
    for (const triggerId of [...this.#active.keys()]) this.remove(triggerId);
  }
}
