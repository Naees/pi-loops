import { hasOnlyKeys, isRecord } from "../shared/validation.js";
import { isTriggerId } from "../shared/ids.js";

export const TRIGGER_EVENT_NAME = "pi-loops:trigger";

export interface TriggerEventPayload {
  readonly schemaVersion: 1;
  readonly triggerId: string;
  readonly eventId?: string;
}

export function parseTriggerEventPayload(value: unknown): TriggerEventPayload {
  if (!isRecord(value) || !hasOnlyKeys(value, ["schemaVersion", "triggerId", "eventId"]) ||
    value.schemaVersion !== 1 || typeof value.triggerId !== "string" || !isTriggerId(value.triggerId) ||
    (value.eventId !== undefined && (typeof value.eventId !== "string" || value.eventId.trim().length === 0 || value.eventId.length > 128))) {
    throw new Error("Pi Loops trigger event has an invalid payload");
  }
  return value as unknown as TriggerEventPayload;
}
