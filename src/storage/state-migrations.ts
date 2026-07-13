import { isRecord } from "../shared/validation.js";

export const CURRENT_STORED_STATE_SCHEMA_VERSION = 1;

export type StoredStateKind = "run" | "schedule" | "trigger";

export interface StoredStateMigration {
  readonly kind: StoredStateKind;
  readonly fromVersion: number;
  readonly toVersion: number;
  migrate(record: Readonly<Record<string, unknown>>): Record<string, unknown>;
}

export interface PreparedStoredState {
  readonly value: unknown;
  readonly migrated: boolean;
  readonly fromVersion?: number;
  readonly toVersion?: number;
}

const REVIEWED_STATE_MIGRATIONS: readonly StoredStateMigration[] = Object.freeze([]);

export class UnsupportedStoredStateVersionError extends Error {
  constructor(kind: StoredStateKind, version: number, supportedVersion: number, newer: boolean) {
    super(newer
      ? `Stored ${kind} record schemaVersion ${version} is newer than supported version ${supportedVersion}`
      : `Stored ${kind} record schemaVersion ${version} has no migration to version ${supportedVersion}`);
    this.name = "UnsupportedStoredStateVersionError";
  }
}

export function applyStoredStateMigrations(
  kind: StoredStateKind,
  input: unknown,
  targetVersion: number,
  migrations: readonly StoredStateMigration[],
): PreparedStoredState {
  if (!Number.isSafeInteger(targetVersion) || targetVersion <= 0) throw new Error("Target state schema version must be a positive safe integer");
  if (!isRecord(input) || !Number.isSafeInteger(input.schemaVersion) || (input.schemaVersion as number) <= 0) {
    return { value: input, migrated: false };
  }

  const fromVersion = input.schemaVersion as number;
  if (fromVersion === targetVersion) return { value: input, migrated: false, fromVersion, toVersion: targetVersion };
  if (fromVersion > targetVersion) throw new UnsupportedStoredStateVersionError(kind, fromVersion, targetVersion, true);

  let version = fromVersion;
  let value = structuredClone(input);
  while (version < targetVersion) {
    const candidates = migrations.filter((migration) => migration.kind === kind && migration.fromVersion === version);
    if (candidates.length !== 1) throw new UnsupportedStoredStateVersionError(kind, version, targetVersion, false);
    const migration = candidates[0];
    if (!migration || migration.toVersion !== version + 1) {
      throw new Error(`Stored ${kind} migration from version ${version} must advance exactly one version`);
    }
    const migrated = migration.migrate(value);
    if (!isRecord(migrated) || migrated.schemaVersion !== migration.toVersion) {
      throw new Error(`Stored ${kind} migration from version ${version} returned an invalid schemaVersion`);
    }
    value = migrated;
    version = migration.toVersion;
  }
  return { value, migrated: true, fromVersion, toVersion: version };
}

export function prepareStoredState(kind: StoredStateKind, input: unknown): PreparedStoredState {
  return applyStoredStateMigrations(
    kind,
    input,
    CURRENT_STORED_STATE_SCHEMA_VERSION,
    REVIEWED_STATE_MIGRATIONS,
  );
}
