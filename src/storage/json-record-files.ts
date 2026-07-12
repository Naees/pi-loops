import { open, readdir } from "node:fs/promises";

export async function readBoundedJsonFile(
  path: string,
  maxBytes: number,
  oversizedMessage: string,
): Promise<unknown | undefined> {
  let handle;
  try {
    handle = await open(path, "r");
    const metadata = await handle.stat();
    if (metadata.size > maxBytes) throw new Error(oversizedMessage);
    const buffer = Buffer.alloc(maxBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > maxBytes) throw new Error(oversizedMessage);
    return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function listRecordIds(directory: string, capturingFilePattern: RegExp): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return names.sort().flatMap((name) => {
    capturingFilePattern.lastIndex = 0;
    const match = capturingFilePattern.exec(name);
    return match?.[1] ? [match[1]] : [];
  });
}
