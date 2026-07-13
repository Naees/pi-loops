import { open, readdir } from "node:fs/promises";
import { readBoundedFile } from "./bounded-file-reader.js";

export async function readBoundedJsonFile(
  path: string,
  maxBytes: number,
  oversizedMessage: string,
): Promise<unknown | undefined> {
  let handle;
  try {
    handle = await open(path, "r");
    const contents = await readBoundedFile(handle, maxBytes, oversizedMessage);
    return JSON.parse(contents.toString("utf8")) as unknown;
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
