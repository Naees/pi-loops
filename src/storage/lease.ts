import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { lock } from "proper-lockfile";
import { writeJsonAtomic } from "./atomic-file.js";

export interface WriterLeaseRecord {
  readonly schemaVersion: 1;
  readonly token: string;
  readonly pid: number;
  readonly acquiredAt: string;
  readonly expiresAt: string;
}

export interface WriterLease {
  readonly path: string;
  readonly record: WriterLeaseRecord;
}

interface LeaseHandle {
  active: boolean;
  compromised?: Error;
  releaseLock: () => Promise<void>;
}

const handles = new WeakMap<WriterLease, LeaseHandle>();

export class LeaseUnavailableError extends Error {
  readonly current?: WriterLeaseRecord;

  constructor(current?: WriterLeaseRecord) {
    super(current ? `Writer lease is already held until ${current.expiresAt}` : "Writer lease is already held");
    this.name = "LeaseUnavailableError";
    if (current !== undefined) this.current = current;
  }
}

export class LeaseOwnershipError extends Error {
  constructor(message = "Writer lease ownership token does not match") {
    super(message);
    this.name = "LeaseOwnershipError";
  }
}

function parseLease(value: unknown): WriterLeaseRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid writer lease record");
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    typeof record.token !== "string" ||
    !Number.isSafeInteger(record.pid) ||
    typeof record.acquiredAt !== "string" ||
    typeof record.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(record.acquiredAt)) ||
    !Number.isFinite(Date.parse(record.expiresAt))
  ) {
    throw new Error("Invalid writer lease record");
  }
  return record as unknown as WriterLeaseRecord;
}

async function readLease(path: string): Promise<WriterLeaseRecord | undefined> {
  try {
    return parseLease(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function acquireWriterLease(
  path: string,
  staleMs: number,
  now: Date = new Date(),
): Promise<WriterLease> {
  if (!Number.isSafeInteger(staleMs) || staleMs < 2_000) {
    throw new Error("Lease stale timeout must be a safe integer of at least 2000ms");
  }

  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle: LeaseHandle = { active: true, releaseLock: async () => undefined };
  let releaseLock: (() => Promise<void>) | undefined;
  try {
    releaseLock = await lock(path, {
      realpath: false,
      stale: staleMs,
      update: Math.max(1_000, Math.floor(staleMs / 2)),
      retries: 0,
      onCompromised(error) {
        handle.active = false;
        handle.compromised = error;
      },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ELOCKED") throw error;
    let current: WriterLeaseRecord | undefined;
    try {
      current = await readLease(path);
    } catch {
      // Metadata is diagnostic only; the proper-lockfile lock remains authoritative.
    }
    throw new LeaseUnavailableError(current);
  }

  const record: WriterLeaseRecord = {
    schemaVersion: 1,
    token: randomUUID(),
    pid: process.pid,
    acquiredAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + staleMs).toISOString(),
  };
  const lease: WriterLease = { path, record };

  try {
    await writeJsonAtomic(path, record);
  } catch (error) {
    await releaseLock();
    throw error;
  }

  handle.releaseLock = releaseLock;
  handles.set(lease, handle);
  return lease;
}

export async function assertWriterLease(lease: WriterLease): Promise<void> {
  const handle = handles.get(lease);
  if (!handle?.active) {
    throw new LeaseOwnershipError(handle?.compromised?.message ?? "Writer lease is not active in this process");
  }
  const current = await readLease(lease.path);
  if (!current || current.token !== lease.record.token) {
    throw new LeaseOwnershipError();
  }
}

export async function releaseWriterLease(lease: WriterLease): Promise<void> {
  const handle = handles.get(lease);
  await assertWriterLease(lease);
  if (!handle) throw new LeaseOwnershipError("Writer lease handle is missing");

  await rm(lease.path, { force: true });
  await handle.releaseLock();
  handle.active = false;
  handles.delete(lease);
}
