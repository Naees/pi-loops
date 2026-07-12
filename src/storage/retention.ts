export interface RetentionCandidate {
  readonly runId: string;
  readonly lastUsedMs: number;
  readonly eligible: boolean;
}

export function selectRetentionEvictions(
  candidates: readonly RetentionCandidate[],
  limit: number,
): string[] {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("Retention limit must be a positive safe integer");
  }

  const eligible = candidates
    .filter((candidate) => candidate.eligible)
    .sort((left, right) => {
      const timeDifference = left.lastUsedMs - right.lastUsedMs;
      return timeDifference === 0 ? left.runId.localeCompare(right.runId) : timeDifference;
    });

  const overflow = Math.max(0, eligible.length - limit);
  return eligible.slice(0, overflow).map((candidate) => candidate.runId);
}
