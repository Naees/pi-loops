import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { errorMessage } from "../shared/errors.js";
import type { TriggerController } from "../triggers/controller.js";
import { parseTriggerEventPayload, TRIGGER_EVENT_NAME } from "../triggers/event-bus.js";

const ERROR_NOTICE_INTERVAL_MS = 1_000;

export interface TriggerEventRelay {
  activate(context: ExtensionContext): void;
  deactivate(): void;
}

export function registerTriggerEventRelay(pi: ExtensionAPI, triggers: TriggerController): TriggerEventRelay {
  let context: ExtensionContext | undefined;
  let lastErrorNoticeAt = Number.NEGATIVE_INFINITY;
  let suppressedErrors = 0;

  const notifyError = (targetContext: ExtensionContext, message: string): void => {
    const now = Date.now();
    if (now - lastErrorNoticeAt < ERROR_NOTICE_INTERVAL_MS) {
      suppressedErrors += 1;
      return;
    }
    const suffix = suppressedErrors > 0 ? ` (${suppressedErrors} similar errors suppressed)` : "";
    suppressedErrors = 0;
    lastErrorNoticeAt = now;
    targetContext.ui.notify(`${message}${suffix}`, "error");
  };

  pi.events.on(TRIGGER_EVENT_NAME, (value) => {
    const activeContext = context;
    if (!activeContext) return;
    try {
      const payload = parseTriggerEventPayload(value);
      void triggers.fireEvent(payload.triggerId, activeContext.cwd, payload.eventId).catch((error: unknown) => {
        notifyError(activeContext, `Pi Loops trigger event failed: ${errorMessage(error)}`);
      });
    } catch (error) {
      notifyError(activeContext, `Pi Loops rejected trigger event: ${errorMessage(error)}`);
    }
  });

  return {
    activate(nextContext) {
      context = nextContext;
    },
    deactivate() {
      context = undefined;
    },
  };
}
