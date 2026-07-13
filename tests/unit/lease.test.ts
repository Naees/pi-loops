import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LeaseOwnershipError,
  LeaseUnavailableError,
  acquireWriterLease,
  assertWriterLease,
  assertWriterLeases,
  combineWriterLeaseSignals,
  releaseWriterLease,
  releaseWriterLeases,
} from "../../src/storage/lease.js";
import { withWriterLease } from "../../src/storage/lease-scope.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function leasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-loops-lease-"));
  temporaryDirectories.push(directory);
  return join(directory, "writer.lease.json");
}

describe("writer leases", () => {
  it("allows only one concurrent owner", async () => {
    const path = await leasePath();
    const results = await Promise.allSettled([
      acquireWriterLease(path, 5_000),
      acquireWriterLease(path, 5_000),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const acquired = results.find((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireWriterLease>>> =>
      result.status === "fulfilled");
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected?.reason).toBeInstanceOf(LeaseUnavailableError);
    if (acquired) await releaseWriterLease(acquired.value);
  });

  it("scopes lease ownership to an operation and releases after failure", async () => {
    const path = await leasePath();
    await expect(withWriterLease(path, 5_000, new Date(), async (lease) => {
      await expect(assertWriterLease(lease)).resolves.toBeUndefined();
      throw new Error("operation failed");
    })).rejects.toThrow("operation failed");
    const nextLease = await acquireWriterLease(path, 5_000);
    await releaseWriterLease(nextLease);
  });

  it("returns scoped operation values and skips operations when acquisition is unavailable", async () => {
    const path = await leasePath();
    await expect(withWriterLease(path, 5_000, new Date(), async () => "value")).resolves.toBe("value");
    const owner = await acquireWriterLease(path, 5_000);
    const operation = vi.fn(async () => "never");
    await expect(withWriterLease(path, 5_000, new Date(), operation)).rejects.toBeInstanceOf(LeaseUnavailableError);
    expect(operation).not.toHaveBeenCalled();
    await releaseWriterLease(owner);
  });

  it("releases only through the active matching lease handle", async () => {
    const path = await leasePath();
    const lease = await acquireWriterLease(path, 5_000);
    await expect(assertWriterLease(lease)).resolves.toBeUndefined();

    const forged = { ...lease, record: { ...lease.record, token: "wrong" } };
    await expect(releaseWriterLease(forged)).rejects.toBeInstanceOf(LeaseOwnershipError);
    await releaseWriterLease(lease);
    await expect(assertWriterLease(lease)).rejects.toBeInstanceOf(LeaseOwnershipError);
    const nextLease = await acquireWriterLease(path, 5_000);
    await releaseWriterLease(nextLease);
  });

  it("bounds lease metadata reads before parsing", async () => {
    const path = await leasePath();
    const lease = await acquireWriterLease(path, 5_000);
    await writeFile(path, Buffer.alloc(16 * 1024 + 1));
    await expect(assertWriterLease(lease)).rejects.toThrow("Invalid writer lease record");
    await writeFile(path, JSON.stringify(lease.record));
    await releaseWriterLease(lease);
  });

  it("fails closed and signals compromise when lease metadata ownership changes", async () => {
    const path = await leasePath();
    const lease = await acquireWriterLease(path, 5_000);
    await writeFile(path, JSON.stringify({ ...lease.record, token: "replacement-owner" }));

    await expect(assertWriterLease(lease)).rejects.toBeInstanceOf(LeaseOwnershipError);
    expect(lease.signal.aborted).toBe(true);
    expect(lease.signal.reason).toBeInstanceOf(LeaseOwnershipError);
    await expect(releaseWriterLease(lease)).rejects.toBeInstanceOf(LeaseOwnershipError);
  });

  it("combines, asserts, and releases multiple leases", async () => {
    const first = await acquireWriterLease(await leasePath(), 5_000);
    const second = await acquireWriterLease(await leasePath(), 5_000);
    expect(combineWriterLeaseSignals([first])).toBe(first.signal);
    const combined = combineWriterLeaseSignals([first, second]);
    expect(combined.aborted).toBe(false);
    await expect(assertWriterLeases([first, second])).resolves.toBeUndefined();
    await releaseWriterLeases([first, second]);
    await expect(assertWriterLease(first)).rejects.toBeInstanceOf(LeaseOwnershipError);
    await expect(assertWriterLease(second)).rejects.toBeInstanceOf(LeaseOwnershipError);
    expect(() => combineWriterLeaseSignals([])).toThrow("At least one writer lease");
    await expect(assertWriterLeases([])).rejects.toThrow("At least one writer lease");
  });

  it("attempts every reverse-order release before aggregating failures", async () => {
    const first = await acquireWriterLease(await leasePath(), 5_000);
    const secondPath = await leasePath();
    const second = await acquireWriterLease(secondPath, 5_000);
    const forgedFirst = { ...first, record: { ...first.record, token: "forged" } };

    await expect(releaseWriterLeases([forgedFirst, second])).rejects.toThrow(AggregateError);
    const replacementSecond = await acquireWriterLease(secondPath, 5_000);
    await releaseWriterLease(replacementSecond);
    await expect(assertWriterLease(first)).resolves.toBeUndefined();
    await releaseWriterLease(first);
  });

  it("signals active owners when the proper-lockfile guard is compromised", async () => {
    const path = await leasePath();
    const lease = await acquireWriterLease(path, 2_000);
    await rm(`${path}.lock`, { recursive: true, force: true });

    await expect(new Promise<unknown>((resolve, reject) => {
      if (lease.signal.aborted) {
        resolve(lease.signal.reason);
        return;
      }
      const timer = setTimeout(() => reject(new Error("Lease compromise was not signalled")), 3_000);
      lease.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve(lease.signal.reason);
      }, { once: true });
    })).resolves.toBeInstanceOf(Error);
    await expect(assertWriterLease(lease)).rejects.toBeInstanceOf(LeaseOwnershipError);
  });

  it("recovers a stale proper-lockfile lock", async () => {
    const path = await leasePath();
    const lockDirectory = `${path}.lock`;
    await mkdir(lockDirectory);
    const old = new Date(Date.now() - 10_000);
    await utimes(lockDirectory, old, old);
    await writeFile(path, JSON.stringify({
      schemaVersion: 1,
      token: "stale-token",
      pid: 1,
      acquiredAt: old.toISOString(),
      expiresAt: new Date(old.getTime() + 2_000).toISOString(),
    }));

    const lease = await acquireWriterLease(path, 2_000);
    await expect(assertWriterLease(lease)).resolves.toBeUndefined();
    await releaseWriterLease(lease);
  });
});
