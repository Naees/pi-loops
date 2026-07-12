import type { ProjectBinding } from "../contracts/project-binding.js";
import {
  acquireWriterLease,
  assertWriterLeases,
  combineWriterLeaseSignals,
  releaseWriterLease,
  releaseWriterLeases,
  type WriterLease,
} from "../storage/lease.js";
import { scheduleClaimLeasePath, scheduleExecutionLeasePath } from "../storage/schedule-store.js";

export interface OccurrenceClaims {
  readonly execution: WriterLease;
  readonly occurrence: WriterLease;
  readonly signal: AbortSignal;
}

export class OccurrenceClaimManager {
  readonly #dataRoot: string;
  readonly #staleMs: number;
  readonly #now: () => Date;

  constructor(options: { dataRoot: string; staleMs: number; now: () => Date }) {
    if (!Number.isSafeInteger(options.staleMs) || options.staleMs < 2_000) {
      throw new Error("Claim lease stale timeout must be a safe integer of at least 2000ms");
    }
    this.#dataRoot = options.dataRoot;
    this.#staleMs = options.staleMs;
    this.#now = options.now;
  }

  async acquire(binding: ProjectBinding, scheduleId: string): Promise<OccurrenceClaims> {
    const execution = await acquireWriterLease(
      scheduleExecutionLeasePath(this.#dataRoot, binding.projectId),
      this.#staleMs,
      this.#now(),
    );
    try {
      const occurrence = await acquireWriterLease(
        scheduleClaimLeasePath(this.#dataRoot, binding.projectId, scheduleId),
        this.#staleMs,
        this.#now(),
      );
      return {
        execution,
        occurrence,
        signal: combineWriterLeaseSignals([execution, occurrence]),
      };
    } catch (error) {
      await releaseWriterLease(execution).catch(() => undefined);
      throw error;
    }
  }

  assert(claims: OccurrenceClaims): Promise<void> {
    return assertWriterLeases([claims.execution, claims.occurrence]);
  }

  release(claims: OccurrenceClaims): Promise<void> {
    return releaseWriterLeases([claims.execution, claims.occurrence]);
  }
}
