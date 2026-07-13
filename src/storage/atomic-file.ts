import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const WINDOWS_RENAME_RETRY_MS = 2_000;
const WINDOWS_RENAME_RETRY_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);

async function replaceFile(temporaryPath: string, path: string): Promise<void> {
  const deadline = Date.now() + WINDOWS_RENAME_RETRY_MS;
  let delayMs = 5;
  while (true) {
    try {
      await rename(temporaryPath, path);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || !code || !WINDOWS_RENAME_RETRY_CODES.has(code) || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(delayMs * 2, 50);
    }
  }
}

export interface AtomicJsonWriteOptions {
  readonly maxBytes?: number;
  readonly oversizedMessage?: string;
}

export async function writeJsonAtomic(path: string, value: unknown, options: AtomicJsonWriteOptions = {}): Promise<void> {
  if (options.maxBytes !== undefined && (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0)) {
    throw new Error("maxBytes must be a non-negative safe integer");
  }
  const json = JSON.stringify(value, null, 2);
  if (json === undefined) throw new Error("Value is not JSON-serializable");
  const serialized = `${json}\n`;
  if (options.maxBytes !== undefined && Buffer.byteLength(serialized, "utf8") > options.maxBytes) {
    throw new Error(options.oversizedMessage ?? `JSON file exceeds ${options.maxBytes} bytes`);
  }
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });

  const temporaryPath = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let created = false;
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    created = true;
    try {
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await replaceFile(temporaryPath, path);
    created = false;
  } finally {
    if (created) await rm(temporaryPath, { force: true });
  }
}
