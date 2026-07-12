import type { ProjectBinding } from "../contracts/project-binding.js";
import {
  acquireWriterLease,
  assertWriterLease,
  releaseWriterLease,
  type WriterLease,
} from "../storage/lease.js";
import { triggerClaimLeasePath } from "../storage/trigger-store.js";

export class TriggerClaimManager {
  readonly #dataRoot: string;
  readonly #staleMs: number;
  readonly #now: () => Date;

  constructor(options: { dataRoot: string; staleMs: number; now: () => Date }) {
    this.#dataRoot = options.dataRoot;
    this.#staleMs = options.staleMs;
    this.#now = options.now;
  }

  acquire(binding: ProjectBinding, triggerId: string): Promise<WriterLease> {
    return acquireWriterLease(triggerClaimLeasePath(this.#dataRoot, binding.projectId, triggerId), this.#staleMs, this.#now());
  }

  assert(claim: WriterLease): Promise<void> {
    return assertWriterLease(claim);
  }

  release(claim: WriterLease): Promise<void> {
    return releaseWriterLease(claim);
  }
}
