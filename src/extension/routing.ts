import type { RunRecord } from "../shared/types.js";

export async function shutdownUnattendedControllers(options: {
  readonly shutdownScheduler: () => Promise<void>;
  readonly shutdownTriggers: () => Promise<void>;
  readonly shutdownWorker: () => Promise<void>;
  readonly interruptAttended: () => Promise<void>;
}): Promise<void> {
  const controllerResults = await Promise.allSettled([
    Promise.resolve().then(options.shutdownScheduler),
    Promise.resolve().then(options.shutdownTriggers),
  ]);
  const finalResults = await Promise.allSettled([
    Promise.resolve().then(options.shutdownWorker),
    Promise.resolve().then(options.interruptAttended),
  ]);
  const errors = [...controllerResults, ...finalResults]
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason as unknown);
  if (errors.length > 0) throw new AggregateError(errors, "One or more Pi Loops shutdown operations failed");
}

export async function routeStopWork(options: {
  readonly requestedId?: string | undefined;
  readonly activeRunId?: string | undefined;
  readonly loadRun: (runId: string) => Promise<RunRecord | undefined>;
  readonly stopSchedule: (id?: string) => Promise<string | undefined>;
  readonly stopTrigger: (id?: string) => Promise<string | undefined>;
  readonly stopGoal: (id?: string) => Promise<RunRecord | undefined>;
}): Promise<
  | { readonly kind: "schedule"; readonly id: string }
  | { readonly kind: "trigger"; readonly id: string }
  | { readonly kind: "goal"; readonly run: RunRecord | undefined }
> {
  if (!options.requestedId && options.activeRunId) {
    const active = await options.loadRun(options.activeRunId);
    if (active?.mode === "proactive") {
      const id = await options.stopTrigger(active.runId);
      if (id) return { kind: "trigger", id };
    }
    if (active?.mode === "scheduled") {
      const id = await options.stopSchedule(active.runId);
      if (id) return { kind: "schedule", id };
    }
  }
  const scheduleId = await options.stopSchedule(options.requestedId);
  if (scheduleId) return { kind: "schedule", id: scheduleId };
  const triggerId = await options.stopTrigger(options.requestedId);
  if (triggerId) return { kind: "trigger", id: triggerId };
  return { kind: "goal", run: await options.stopGoal(options.requestedId) };
}
