import { isRunId } from "../shared/ids.js";
import type { SchedulePauseReason, ScheduleRecord } from "../shared/types.js";
import { nextRecurringFireAt } from "./parser.js";

export type ScheduleTriggerDecision =
  | { readonly action: "start"; readonly schedule: ScheduleRecord }
  | { readonly action: "coalesced"; readonly schedule: ScheduleRecord }
  | { readonly action: "ignored"; readonly schedule: ScheduleRecord };

function timestamp(now: Date): string {
  if (!Number.isFinite(now.getTime())) throw new Error("Schedule clock must be a valid date");
  return now.toISOString();
}

function withoutExecutionFields(schedule: ScheduleRecord): Omit<ScheduleRecord, "activeRunId" | "pendingSince" | "pauseReason"> {
  const mutable: { -readonly [Key in keyof ScheduleRecord]: ScheduleRecord[Key] } = { ...schedule };
  delete mutable.activeRunId;
  delete mutable.pendingSince;
  delete mutable.pauseReason;
  return mutable;
}

function advanceRecurring(schedule: ScheduleRecord, now: Date): string | undefined {
  return schedule.timing.kind === "recurring"
    ? nextRecurringFireAt(schedule.timing.anchorAt, schedule.timing.intervalMs, now)
    : undefined;
}

function pauseSchedule(
  schedule: ScheduleRecord,
  reason: SchedulePauseReason,
  now: Date,
  lastCompletedAt?: string,
): ScheduleRecord {
  const mutable: { -readonly [Key in keyof ScheduleRecord]: ScheduleRecord[Key] } = {
    ...withoutExecutionFields(schedule),
    state: "paused",
    pauseReason: reason,
    updatedAt: timestamp(now),
    ...(lastCompletedAt === undefined ? {} : { lastCompletedAt }),
  };
  delete mutable.nextFireAt;
  return mutable;
}

export function reconcileMissedSchedule(schedule: ScheduleRecord, now: Date): ScheduleRecord {
  if (schedule.state === "running" || schedule.state === "pending_coalesced") {
    return pauseSchedule(schedule, "interrupted", now);
  }
  if (schedule.state !== "enabled" || schedule.nextFireAt === undefined || Date.parse(schedule.nextFireAt) > now.getTime()) {
    return schedule;
  }
  if (schedule.timing.kind === "once") return pauseSchedule(schedule, "missed", now);
  return {
    ...schedule,
    nextFireAt: nextRecurringFireAt(schedule.timing.anchorAt, schedule.timing.intervalMs, now),
    updatedAt: timestamp(now),
  };
}

export function triggerSchedule(schedule: ScheduleRecord, runId: string, now: Date): ScheduleTriggerDecision {
  if (!isRunId(runId)) throw new Error(`Invalid run ID: ${runId}`);
  const at = timestamp(now);
  if (schedule.state === "paused" || schedule.nextFireAt === undefined || Date.parse(schedule.nextFireAt) > now.getTime()) {
    return { action: "ignored", schedule };
  }
  const nextFireAt = advanceRecurring(schedule, now);
  if (schedule.state === "running" || schedule.state === "pending_coalesced") {
    const coalesced: ScheduleRecord = {
      ...schedule,
      state: "pending_coalesced",
      ...(nextFireAt === undefined ? {} : { nextFireAt }),
      pendingSince: schedule.pendingSince ?? at,
      updatedAt: at,
    };
    return { action: "coalesced", schedule: coalesced };
  }

  const mutable: { -readonly [Key in keyof ScheduleRecord]: ScheduleRecord[Key] } = {
    ...schedule,
    state: "running",
    activeRunId: runId,
    lastTriggeredAt: at,
    updatedAt: at,
  };
  if (nextFireAt === undefined) delete mutable.nextFireAt;
  else mutable.nextFireAt = nextFireAt;
  delete mutable.pauseReason;
  return { action: "start", schedule: mutable };
}

export function completeScheduleOccurrence(
  schedule: ScheduleRecord,
  runId: string,
  now: Date,
  replacementRunId?: string,
): { readonly action: "enabled" | "start_pending" | "paused"; readonly schedule: ScheduleRecord } {
  if ((schedule.state !== "running" && schedule.state !== "pending_coalesced") || schedule.activeRunId !== runId) {
    throw new Error(`Schedule ${schedule.scheduleId} is not running occurrence ${runId}`);
  }
  const at = timestamp(now);
  if (schedule.state === "pending_coalesced") {
    if (!replacementRunId) throw new Error("A coalesced occurrence requires a replacement run ID");
    if (!isRunId(replacementRunId)) throw new Error(`Invalid run ID: ${replacementRunId}`);
    const next: ScheduleRecord = {
      ...withoutExecutionFields(schedule),
      state: "running",
      activeRunId: replacementRunId,
      lastTriggeredAt: at,
      lastCompletedAt: at,
      updatedAt: at,
    };
    return { action: "start_pending", schedule: next };
  }
  if (schedule.timing.kind === "once") {
    return { action: "paused", schedule: pauseSchedule(schedule, "completed", now, at) };
  }
  return {
    action: "enabled",
    schedule: {
      ...withoutExecutionFields(schedule),
      state: "enabled",
      lastCompletedAt: at,
      updatedAt: at,
    },
  };
}

export function interruptScheduleOccurrence(schedule: ScheduleRecord, runId: string, now: Date): ScheduleRecord {
  if ((schedule.state !== "running" && schedule.state !== "pending_coalesced") || schedule.activeRunId !== runId) {
    throw new Error(`Schedule ${schedule.scheduleId} is not running occurrence ${runId}`);
  }
  return pauseSchedule(schedule, "interrupted", now);
}

export function resumeScheduleOccurrence(schedule: ScheduleRecord, runId: string, now: Date): ScheduleRecord {
  if (!isRunId(runId)) throw new Error(`Invalid run ID: ${runId}`);
  if (schedule.state !== "paused" || schedule.pauseReason !== "interrupted") {
    throw new Error(`Schedule is not resumable: ${schedule.scheduleId}`);
  }
  const at = timestamp(now);
  const mutable: { -readonly [Key in keyof ScheduleRecord]: ScheduleRecord[Key] } = {
    ...schedule,
    state: "running",
    activeRunId: runId,
    lastTriggeredAt: at,
    updatedAt: at,
  };
  delete mutable.pauseReason;
  delete mutable.pendingSince;
  if (schedule.timing.kind === "recurring") {
    mutable.nextFireAt = nextRecurringFireAt(schedule.timing.anchorAt, schedule.timing.intervalMs, now);
  } else {
    delete mutable.nextFireAt;
  }
  return mutable;
}
