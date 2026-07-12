import type { RunBudget } from "../shared/types.js";
import { isRecord } from "../shared/validation.js";

export interface PiLoopsConfig {
  readonly schemaVersion: 1;
  readonly defaults: RunBudget;
  readonly scheduling: {
    readonly minimumRecurringMs: number;
  };
  readonly retention: {
    readonly terminalRunsPerProject: number;
  };
  readonly evaluator: {
    readonly model: "current" | string;
  };
}

export interface PiLoopsConfigOverride {
  readonly schemaVersion?: 1;
  readonly defaults?: Partial<RunBudget>;
  readonly scheduling?: Partial<PiLoopsConfig["scheduling"]>;
  readonly retention?: Partial<PiLoopsConfig["retention"]>;
  readonly evaluator?: Partial<PiLoopsConfig["evaluator"]>;
}

export const DEFAULT_CONFIG: PiLoopsConfig = Object.freeze({
  schemaVersion: 1,
  defaults: Object.freeze({
    maxActiveMs: 3 * 60 * 60 * 1000,
    maxCycles: 15,
    stallThreshold: 3,
  }),
  scheduling: Object.freeze({
    minimumRecurringMs: 5 * 60 * 1000,
  }),
  retention: Object.freeze({
    terminalRunsPerProject: 50,
  }),
  evaluator: Object.freeze({
    model: "current",
  }),
});

function requireRecord(source: string, path: string, value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${source}: ${path} must be an object`);
  return value;
}

function rejectUnknownKeys(source: string, path: string, value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) throw new Error(`${source}: unknown ${path} key(s): ${unknown.join(", ")}`);
}

function readPositiveInteger(source: string, path: string, value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${source}: ${path} must be a positive safe integer`);
  }
  return value as number;
}

export function parseConfigOverride(input: unknown, source = "config"): PiLoopsConfigOverride {
  if (input === undefined) return {};
  const root = requireRecord(source, "config", input);
  rejectUnknownKeys(source, "config", root, ["schemaVersion", "defaults", "scheduling", "retention", "evaluator"]);

  const result: {
    schemaVersion?: 1;
    defaults?: Partial<RunBudget>;
    scheduling?: Partial<PiLoopsConfig["scheduling"]>;
    retention?: Partial<PiLoopsConfig["retention"]>;
    evaluator?: Partial<PiLoopsConfig["evaluator"]>;
  } = {};

  if (root.schemaVersion !== undefined) {
    if (root.schemaVersion !== 1) throw new Error(`${source}: unsupported schemaVersion ${String(root.schemaVersion)}`);
    result.schemaVersion = 1;
  }

  if (root.defaults !== undefined) {
    const defaults = requireRecord(source, "defaults", root.defaults);
    rejectUnknownKeys(source, "defaults", defaults, ["maxActiveMs", "maxCycles", "stallThreshold"]);
    result.defaults = {
      ...(defaults.maxActiveMs === undefined ? {} : { maxActiveMs: readPositiveInteger(source, "defaults.maxActiveMs", defaults.maxActiveMs) }),
      ...(defaults.maxCycles === undefined ? {} : { maxCycles: readPositiveInteger(source, "defaults.maxCycles", defaults.maxCycles) }),
      ...(defaults.stallThreshold === undefined ? {} : { stallThreshold: readPositiveInteger(source, "defaults.stallThreshold", defaults.stallThreshold) }),
    };
  }

  if (root.scheduling !== undefined) {
    const scheduling = requireRecord(source, "scheduling", root.scheduling);
    rejectUnknownKeys(source, "scheduling", scheduling, ["minimumRecurringMs"]);
    result.scheduling = {
      ...(scheduling.minimumRecurringMs === undefined
        ? {}
        : { minimumRecurringMs: readPositiveInteger(source, "scheduling.minimumRecurringMs", scheduling.minimumRecurringMs) }),
    };
  }

  if (root.retention !== undefined) {
    const retention = requireRecord(source, "retention", root.retention);
    rejectUnknownKeys(source, "retention", retention, ["terminalRunsPerProject"]);
    result.retention = {
      ...(retention.terminalRunsPerProject === undefined
        ? {}
        : { terminalRunsPerProject: readPositiveInteger(source, "retention.terminalRunsPerProject", retention.terminalRunsPerProject) }),
    };
  }

  if (root.evaluator !== undefined) {
    const evaluator = requireRecord(source, "evaluator", root.evaluator);
    rejectUnknownKeys(source, "evaluator", evaluator, ["model"]);
    if (evaluator.model !== undefined && (typeof evaluator.model !== "string" || evaluator.model.trim().length === 0)) {
      throw new Error(`${source}: evaluator.model must be a non-empty string`);
    }
    result.evaluator = evaluator.model === undefined ? {} : { model: evaluator.model as string };
  }

  return result;
}

export function validateConfig(config: PiLoopsConfig): PiLoopsConfig {
  parseConfigOverride(config, "resolved config");
  return config;
}

export function resolveConfig(user: unknown = {}, project: unknown = {}, invocation: unknown = {}): PiLoopsConfig {
  const layers = [
    parseConfigOverride(user, "user config"),
    parseConfigOverride(project, "project config"),
    parseConfigOverride(invocation, "invocation config"),
  ];

  let resolved: PiLoopsConfig = {
    schemaVersion: 1,
    defaults: { ...DEFAULT_CONFIG.defaults },
    scheduling: { ...DEFAULT_CONFIG.scheduling },
    retention: { ...DEFAULT_CONFIG.retention },
    evaluator: { ...DEFAULT_CONFIG.evaluator },
  };

  for (const layer of layers) {
    resolved = {
      schemaVersion: 1,
      defaults: { ...resolved.defaults, ...layer.defaults },
      scheduling: { ...resolved.scheduling, ...layer.scheduling },
      retention: { ...resolved.retention, ...layer.retention },
      evaluator: { ...resolved.evaluator, ...layer.evaluator },
    };
  }

  return validateConfig(resolved);
}
