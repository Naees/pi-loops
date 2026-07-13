import { describe, expect, it, vi } from "vitest";
import {
  applyStoredStateMigrations,
  CURRENT_STORED_STATE_SCHEMA_VERSION,
  prepareStoredState,
  UnsupportedStoredStateVersionError,
  type StoredStateMigration,
} from "../../src/storage/state-migrations.js";

describe("stored state migrations", () => {
  it("accepts current version-one records unchanged", () => {
    const input = { schemaVersion: 1, runId: "run_1234abcd" };
    const prepared = prepareStoredState("run", input);
    expect(CURRENT_STORED_STATE_SCHEMA_VERSION).toBe(1);
    expect(prepared).toEqual({ value: input, migrated: false, fromVersion: 1, toVersion: 1 });
    expect(prepared.value).toBe(input);
  });

  it("leaves malformed version fields to the strict record parser", () => {
    for (const input of [null, [], {}, { schemaVersion: 0 }, { schemaVersion: 1.5 }, { schemaVersion: "1" }]) {
      const prepared = prepareStoredState("schedule", input);
      expect(prepared).toEqual({ value: input, migrated: false });
      expect(prepared.value).toBe(input);
    }
  });

  it("fails closed for newer versions and older versions without a reviewed path", () => {
    expect(() => applyStoredStateMigrations("trigger", { schemaVersion: 4 }, 3, []))
      .toThrow(new UnsupportedStoredStateVersionError("trigger", 4, 3, true));
    expect(() => applyStoredStateMigrations("run", { schemaVersion: 1 }, 2, []))
      .toThrow("schemaVersion 1 has no migration to version 2");
  });

  it("applies a complete sequential path without mutating the source record", () => {
    const first = vi.fn((record: Readonly<Record<string, unknown>>) => ({ ...record, schemaVersion: 2, added: "first" }));
    const second = vi.fn((record: Readonly<Record<string, unknown>>) => ({ ...record, schemaVersion: 3, addedAgain: true }));
    const migrations: StoredStateMigration[] = [
      { kind: "run", fromVersion: 1, toVersion: 2, migrate: first },
      { kind: "run", fromVersion: 2, toVersion: 3, migrate: second },
    ];
    const input = { schemaVersion: 1, nested: { preserved: true } };

    expect(applyStoredStateMigrations("run", input, 3, migrations)).toEqual({
      value: { schemaVersion: 3, nested: { preserved: true }, added: "first", addedAgain: true },
      migrated: true,
      fromVersion: 1,
      toVersion: 3,
    });
    expect(input).toEqual({ schemaVersion: 1, nested: { preserved: true } });
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });

  it("rejects skipped versions, incorrect outputs, and invalid targets", () => {
    expect(() => applyStoredStateMigrations("run", { schemaVersion: 1 }, 2, [{
      kind: "run",
      fromVersion: 1,
      toVersion: 3,
      migrate: (record) => ({ ...record, schemaVersion: 3 }),
    }])).toThrow("must advance exactly one version");
    expect(() => applyStoredStateMigrations("run", { schemaVersion: 1 }, 2, [{
      kind: "run",
      fromVersion: 1,
      toVersion: 2,
      migrate: (record) => ({ ...record, schemaVersion: 1 }),
    }])).toThrow("returned an invalid schemaVersion");
    expect(() => applyStoredStateMigrations("run", { schemaVersion: 1 }, 0, []))
      .toThrow("Target state schema version must be a positive safe integer");
  });
});
