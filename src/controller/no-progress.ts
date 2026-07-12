import { createHash } from "node:crypto";

export interface ProgressTracker {
  readonly signature?: string;
  readonly equivalentFailures: number;
}

export const EMPTY_PROGRESS_TRACKER: ProgressTracker = Object.freeze({ equivalentFailures: 0 });

export function createFailureSignature(failedCriteria: readonly string[], verifierSummaries: readonly string[]): string {
  const normalized = [...failedCriteria, ...verifierSummaries]
    .map((value) => value.trim().replace(/\s+/g, " ").toLowerCase())
    .filter(Boolean)
    .sort();

  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export function recordFailure(tracker: ProgressTracker, signature: string): ProgressTracker {
  if (tracker.signature === signature) {
    return { signature, equivalentFailures: tracker.equivalentFailures + 1 };
  }
  return { signature, equivalentFailures: 1 };
}

export function isStalled(tracker: ProgressTracker, threshold: number): boolean {
  if (!Number.isSafeInteger(threshold) || threshold <= 0) {
    throw new Error("Stall threshold must be a positive safe integer");
  }
  return tracker.equivalentFailures >= threshold;
}
