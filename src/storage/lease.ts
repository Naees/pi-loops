import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { lock } from "proper-lockfile";
import { writeJsonAtomic } from "./atomic-file.js";
import { readBoundedJsonFile } from "./json-record-files.js";

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
  readonly signal: AbortSignal;
}

interface LeaseHandle {
  active: boolean;
  guardCompromised: boolean;
  compromised?: Error;
  readonly compromise: AbortController;
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
  const value = await readBoundedJsonFile(path, 16 * 1024, "Invalid writer lease record");
  return value === undefined ? undefined : parseLease(value);
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
  const handle: LeaseHandle = {
    active: true,
    guardCompromised: false,
    compromise: new AbortController(),
    releaseLock: async () => undefined,
  };
  let releaseLock: (() => Promise<void>) | undefined;
  try {
    releaseLock = await lock(path, {
      realpath: false,
      stale: staleMs,
      update: Math.max(1_000, Math.floor(staleMs / 2)),
      retries: 0,
      onCompromised(error) {
        handle.active = false;
        handle.guardCompromised = true;
        handle.compromised = error;
        handle.compromise.abort(error);
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
  const lease: WriterLease = { path, record, signal: handle.compromise.signal };

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
  if (!handle.active) {
    throw new LeaseOwnershipError(handle.compromised?.message ?? "Writer lease is not active in this process");
  }
  if (!current || current.token !== lease.record.token) {
    const error = new LeaseOwnershipError();
    handle.active = false;
    handle.compromised = error;
    handle.compromise.abort(error);
    throw error;
  }
}

export async function releaseWriterLease(lease: WriterLease): Promise<void> {
  const handle = handles.get(lease);
  if (!handle) throw new LeaseOwnershipError("Writer lease handle is missing");

  try {
    await assertWriterLease(lease);
  } catch (ownershipError) {
    if (handle.guardCompromised) {
      handles.delete(lease);
      throw ownershipError;
    }

    try {
      await handle.releaseLock();
      handles.delete(lease);
    } catch (releaseError) {
      throw new AggregateError(
        [ownershipError, releaseError],
        "Writer lease ownership was lost and its local lock handle could not be released",
      );
    } finally {
      handle.active = false;
    }
    throw ownershipError;
  }

  await rm(lease.path, { force: true });
  await handle.releaseLock();
  handle.active = false;
  handles.delete(lease);
}

export function combineWriterLeaseSignals(leases: readonly WriterLease[]): AbortSignal {
  const first = leases[0];
  if (!first) throw new Error("At least one writer lease is required");
  return leases.length === 1 ? first.signal : AbortSignal.any(leases.map((lease) => lease.signal));
}

export async function assertWriterLeases(leases: readonly WriterLease[]): Promise<void> {
  if (leases.length === 0) throw new Error("At least one writer lease is required");
  for (const lease of leases) await assertWriterLease(lease);
  const compromised = leases.find((lease) => lease.signal.aborted);
  if (compromised) {
    const reason = compromised.signal.reason;
    throw reason instanceof Error ? reason : new LeaseOwnershipError("Writer lease is not active");
  }
}

export async function releaseWriterLeases(leasesInAcquisitionOrder: readonly WriterLease[]): Promise<void> {
  const failures: unknown[] = [];
  for (const lease of [...leasesInAcquisitionOrder].reverse()) {
    try {
      await releaseWriterLease(lease);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "Could not release writer leases");
}
