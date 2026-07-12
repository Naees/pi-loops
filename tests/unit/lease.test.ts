import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LeaseOwnershipError, LeaseUnavailableError, acquireWriterLease, assertWriterLease, releaseWriterLease } from "../../src/storage/lease.js";

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
