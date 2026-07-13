import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

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
    await rename(temporaryPath, path);
    created = false;
  } finally {
    if (created) await rm(temporaryPath, { force: true });
  }
}
