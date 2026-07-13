import { describe, expect, it } from "vitest";
import type { CompletionEvaluator } from "../../src/evidence/evaluator.js";
import { routeStopWork as routeFromIndex, shutdownUnattendedControllers as shutdownFromIndex } from "../../src/extension/index.js";
import { routeStopWork, shutdownUnattendedControllers } from "../../src/extension/routing.js";
import {
  ScheduleController,
  type ScheduleOccurrenceKind,
  type ScheduleOccurrenceResult,
  type ScheduleOccurrenceRunner,
} from "../../src/scheduler/scheduler.js";
import * as ids from "../../src/shared/ids.js";
import type { ScheduleRecord, TriggerRecord } from "../../src/shared/types.js";
import * as validation from "../../src/shared/validation.js";
import * as lease from "../../src/storage/lease.js";
import { UnattendedRunController, type UnattendedRunHost } from "../../src/controller/unattended-run-controller.js";
import type { TriggerOccurrenceKind, TriggerOccurrenceRunner } from "../../src/triggers/controller.js";

describe("public API compatibility", () => {
  it("retains established runtime module namespaces and extension re-exports", () => {
    expect(Object.keys(ids).sort()).toEqual([
      "createProjectId", "createRunId", "createScheduleId", "createTriggerId",
      "isProjectId", "isRunId", "isScheduleId", "isTriggerId",
    ]);
    expect(Object.keys(validation).sort()).toEqual([
      "hasOnlyKeys", "isPositiveSafeInteger", "isRecord", "isRunBudget", "isStringArray",
    ]);
    expect(Object.keys(lease).sort()).toEqual([
      "LeaseOwnershipError", "LeaseUnavailableError", "acquireWriterLease", "assertWriterLease",
      "assertWriterLeases", "combineWriterLeaseSignals", "releaseWriterLease", "releaseWriterLeases",
    ]);
    expect(routeFromIndex).toBe(routeStopWork);
    expect(shutdownFromIndex).toBe(shutdownUnattendedControllers);
    expect(ScheduleController).toBeTypeOf("function");
  });

  it("retains established occurrence and unattended controller signatures", () => {
    const kind: ScheduleOccurrenceKind = "restart";
    const triggerKind: TriggerOccurrenceKind = kind;
    const result: ScheduleOccurrenceResult = { status: "interrupted" };
    const scheduleRunner: ScheduleOccurrenceRunner = async () => result;
    const triggerRunner: TriggerOccurrenceRunner = async () => result;
    type RunSchedule = (
      schedule: ScheduleRecord,
      runId: string,
      evaluator: CompletionEvaluator,
      host: UnattendedRunHost,
      signal: AbortSignal,
      kind?: ScheduleOccurrenceKind,
    ) => Promise<ScheduleOccurrenceResult>;
    type RunTrigger = (
      trigger: TriggerRecord,
      runId: string,
      evaluator: CompletionEvaluator,
      host: UnattendedRunHost,
      signal: AbortSignal,
      kind?: TriggerOccurrenceKind,
    ) => Promise<ScheduleOccurrenceResult>;
    const runSchedule: RunSchedule = UnattendedRunController.prototype.runSchedule;
    const runTrigger: RunTrigger = UnattendedRunController.prototype.runTrigger;
    expect([triggerKind, scheduleRunner, triggerRunner, runSchedule, runTrigger]).toHaveLength(5);
  });
});
