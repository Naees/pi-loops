import { acquireWriterLease, releaseWriterLease, type WriterLease } from "./lease.js";

export async function withWriterLease<T>(
  path: string,
  staleMs: number,
  now: Date,
  operation: (lease: WriterLease) => Promise<T>,
): Promise<T> {
  const lease = await acquireWriterLease(path, staleMs, now);
  try {
    return await operation(lease);
  } finally {
    await releaseWriterLease(lease);
  }
}
