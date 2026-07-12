export type TriggerFireResult = "started" | "coalesced" | "ignored";

interface EventIngressState {
  currentEventId: string | undefined;
  pending: boolean;
  pendingEventId: string | undefined;
}

interface EventWindow {
  untilMs: number;
  coalesced: boolean;
}

const EVENT_DEBOUNCE_MS = 250;
const MAX_EVENT_IDS_PER_TRIGGER = 128;
const MAX_EVENT_INGRESS = 64;

export class TriggerEventIngress {
  readonly #now: () => Date;
  readonly #windows = new Map<string, EventWindow>();
  readonly #eventIds = new Map<string, Set<string>>();
  readonly #active = new Map<string, EventIngressState>();

  constructor(now: () => Date) {
    this.#now = now;
  }

  async dispatch(
    triggerId: string,
    eventId: string | undefined,
    deliver: () => Promise<TriggerFireResult>,
  ): Promise<TriggerFireResult> {
    const seen = this.#eventIds.get(triggerId);
    if (eventId && seen?.has(eventId)) return "ignored";

    const active = this.#active.get(triggerId);
    if (active) return this.#coalesce(active, triggerId, eventId);

    const nowMs = this.#now().getTime();
    const window = this.#windows.get(triggerId);
    if (window && nowMs < window.untilMs) {
      if (window.coalesced) return "coalesced";
      window.coalesced = true;
    } else {
      this.#windows.set(triggerId, { untilMs: nowMs + EVENT_DEBOUNCE_MS, coalesced: false });
    }
    if (this.#active.size >= MAX_EVENT_INGRESS) throw new Error("Pi Loops trigger event ingress is at capacity");

    const admitted: EventIngressState = { currentEventId: eventId, pending: false, pendingEventId: undefined };
    this.#active.set(triggerId, admitted);
    try {
      const initial = await deliver();
      this.#rememberEventId(triggerId, eventId);
      while (admitted.pending) {
        const pendingEventId = admitted.pendingEventId;
        admitted.pending = false;
        admitted.currentEventId = pendingEventId;
        admitted.pendingEventId = undefined;
        await deliver();
        this.#rememberEventId(triggerId, pendingEventId);
      }
      return initial;
    } catch (error) {
      this.#windows.delete(triggerId);
      throw error;
    } finally {
      this.#active.delete(triggerId);
    }
  }

  forget(triggerId: string): void {
    this.#windows.delete(triggerId);
    this.#eventIds.delete(triggerId);
    this.#active.delete(triggerId);
  }

  clear(): void {
    this.#windows.clear();
    this.#eventIds.clear();
    this.#active.clear();
  }

  #coalesce(active: EventIngressState, triggerId: string, eventId: string | undefined): TriggerFireResult {
    if (eventId && (eventId === active.currentEventId || eventId === active.pendingEventId)) return "ignored";
    const window = this.#windows.get(triggerId);
    if (active.pending || window?.coalesced) return "coalesced";
    active.pending = true;
    active.pendingEventId = eventId;
    if (window) window.coalesced = true;
    return "coalesced";
  }

  #rememberEventId(triggerId: string, eventId: string | undefined): void {
    if (!eventId) return;
    const seen = this.#eventIds.get(triggerId) ?? new Set<string>();
    seen.add(eventId);
    if (seen.size > MAX_EVENT_IDS_PER_TRIGGER) seen.delete(seen.values().next().value as string);
    this.#eventIds.set(triggerId, seen);
  }
}
