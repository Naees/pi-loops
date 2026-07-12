import { readdir, readFile, stat } from "node:fs/promises";

export async function readBoundedJsonFile(
  path: string,
  maxBytes: number,
  oversizedMessage: string,
): Promise<unknown | undefined> {
  try {
    const metadata = await stat(path);
    if (metadata.size > maxBytes) throw new Error(oversizedMessage);
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
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
