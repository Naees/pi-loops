import { open, readdir } from "node:fs/promises";
import { writeJsonAtomic } from "./atomic-file.js";
import { readBoundedFile } from "./bounded-file-reader.js";
import { prepareStoredState, type StoredStateKind } from "./state-migrations.js";

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

export interface StoredJsonRecord<T> {
  readonly record: T;
  readonly migrated: boolean;
}

export async function readStoredJsonRecord<T>(
  path: string,
  kind: StoredStateKind,
  maxBytes: number,
  oversizedMessage: string,
  parse: (value: unknown) => T,
): Promise<StoredJsonRecord<T> | undefined> {
  const value = await readBoundedJsonFile(path, maxBytes, oversizedMessage);
  if (value === undefined) return undefined;
  const prepared = prepareStoredState(kind, value);
  return { record: parse(prepared.value), migrated: prepared.migrated };
}

export async function writeStoredJsonRecord(
  path: string,
  record: unknown,
  maxBytes: number,
  oversizedMessage: string,
): Promise<void> {
  await writeJsonAtomic(path, record, { maxBytes, oversizedMessage });
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
