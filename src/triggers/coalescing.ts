import { isRunId } from "../shared/ids.js";
import type { TriggerRecord } from "../shared/types.js";

export type TriggerDecision =
  | { readonly action: "start"; readonly trigger: TriggerRecord }
  | { readonly action: "coalesced"; readonly trigger: TriggerRecord }
  | { readonly action: "ignored"; readonly trigger: TriggerRecord };

function timestamp(now: Date): string {
  if (!Number.isFinite(now.getTime())) throw new Error("Trigger clock must be a valid date");
  return now.toISOString();
}

function withoutExecution(trigger: TriggerRecord): Omit<TriggerRecord, "activeRunId" | "pendingSince"> {
  const mutable: { -readonly [Key in keyof TriggerRecord]: TriggerRecord[Key] } = { ...trigger };
  delete mutable.activeRunId;
  delete mutable.pendingSince;
  return mutable;
}

export function fireTrigger(trigger: TriggerRecord, runId: string, now: Date): TriggerDecision {
  if (!isRunId(runId)) throw new Error(`Invalid run ID: ${runId}`);
  if (trigger.state === "paused") return { action: "ignored", trigger };
  const at = timestamp(now);
  if (trigger.state === "running" || trigger.state === "pending_coalesced") {
    return {
      action: "coalesced",
      trigger: {
        ...trigger,
        state: "pending_coalesced",
        pendingSince: trigger.pendingSince ?? at,
        updatedAt: at,
      },
    };
  }
  return {
    action: "start",
    trigger: {
      ...trigger,
      state: "running",
      activeRunId: runId,
      lastTriggeredAt: at,
      updatedAt: at,
    },
  };
}

export function completeTriggerOccurrence(
  trigger: TriggerRecord,
  runId: string,
  now: Date,
  replacementRunId?: string,
): { readonly action: "enabled" | "start_pending"; readonly trigger: TriggerRecord } {
  if ((trigger.state !== "running" && trigger.state !== "pending_coalesced") || trigger.activeRunId !== runId) {
    throw new Error(`Trigger ${trigger.triggerId} is not running occurrence ${runId}`);
  }
  const at = timestamp(now);
  if (trigger.state === "pending_coalesced") {
    if (!replacementRunId || !isRunId(replacementRunId)) throw new Error("A coalesced trigger requires a valid replacement run ID");
    return {
      action: "start_pending",
      trigger: {
        ...withoutExecution(trigger),
        state: "running",
        activeRunId: replacementRunId,
        lastTriggeredAt: at,
        lastCompletedAt: at,
        updatedAt: at,
      },
    };
  }
  return {
    action: "enabled",
    trigger: {
      ...withoutExecution(trigger),
      state: "enabled",
      lastCompletedAt: at,
      updatedAt: at,
    },
  };
}

export function interruptTriggerOccurrence(trigger: TriggerRecord, runId: string, now: Date): TriggerRecord {
  if ((trigger.state !== "running" && trigger.state !== "pending_coalesced") || trigger.activeRunId !== runId) {
    throw new Error(`Trigger ${trigger.triggerId} is not running occurrence ${runId}`);
  }
  return { ...withoutExecution(trigger), state: "enabled", updatedAt: timestamp(now) };
}

export function pauseTrigger(trigger: TriggerRecord, now: Date): TriggerRecord {
  if (trigger.state === "running" || trigger.state === "pending_coalesced") {
    throw new Error(`Active trigger must be stopped before pausing: ${trigger.triggerId}`);
  }
  return { ...withoutExecution(trigger), state: "paused", updatedAt: timestamp(now) };
}

export function enableTrigger(trigger: TriggerRecord, now: Date): TriggerRecord {
  if (trigger.state !== "paused") throw new Error(`Trigger is not paused: ${trigger.triggerId}`);
  return { ...trigger, state: "enabled", updatedAt: timestamp(now) };
}

export function resumeTriggerOccurrence(trigger: TriggerRecord, runId: string, now: Date): TriggerRecord {
  if (!isRunId(runId)) throw new Error(`Invalid run ID: ${runId}`);
  if (trigger.state !== "enabled") throw new Error(`Trigger is not available for resume: ${trigger.triggerId}`);
  const at = timestamp(now);
  return { ...trigger, state: "running", activeRunId: runId, lastTriggeredAt: at, updatedAt: at };
}
