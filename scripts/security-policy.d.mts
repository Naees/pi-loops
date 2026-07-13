export const APPROVED_PRODUCTION_LICENSES: readonly string[];

export interface AuditCounts {
  readonly info: number;
  readonly low: number;
  readonly moderate: number;
  readonly high: number;
  readonly critical: number;
  readonly total: number;
}

export interface ProductionDependencyInventoryEntry {
  readonly name: string;
  readonly version: string;
  readonly licenses: readonly string[];
}

export interface SecretScanEntry {
  readonly path: string;
  readonly text: string;
}

export interface SecretFinding {
  readonly path: string;
  readonly kind: string;
}

export interface UnpinnedActionFinding {
  readonly path: string;
  readonly line: number;
  readonly uses: string;
}

export function validateAuditReport(value: unknown): AuditCounts;
export function validateCycloneDxSbom(
  value: unknown,
  approvedLicenses?: readonly string[],
): ProductionDependencyInventoryEntry[];
export function findPotentialSecrets(entries: readonly SecretScanEntry[]): SecretFinding[];
export function findUnpinnedGitHubActions(entries: readonly SecretScanEntry[]): UnpinnedActionFinding[];
