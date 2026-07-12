import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GoalLoopHost } from "../controller/attended-goal-controller.js";
import type { UnattendedRunHost } from "../controller/unattended-run-controller.js";
import { conciseRunEntry } from "./presentation.js";

export function createGoalHost(pi: ExtensionAPI, ctx: ExtensionContext): GoalLoopHost {
  return {
    cwd: ctx.cwd,
    isIdle: ctx.isIdle(),
    sendWork(message, delivery) {
      if (delivery === "followUp") pi.sendUserMessage(message, { deliverAs: "followUp" });
      else pi.sendUserMessage(message);
    },
    notify(message, level) {
      ctx.ui.notify(message, level);
    },
    appendRunEntry(run) {
      pi.appendEntry("pi-loops.run", conciseRunEntry(run));
    },
    abortAgent() {
      ctx.abort();
    },
    async selectRun(runs) {
      if (!ctx.hasUI) return undefined;
      const labels = runs.map((run) => `${run.runId}  ${run.state}  ${run.goal}`);
      const selected = await ctx.ui.select("Resume which Pi Loops run?", labels);
      return selected?.split(/\s+/, 1)[0];
    },
  };
}

export function createUnattendedHost(pi: ExtensionAPI, ctx: ExtensionContext): UnattendedRunHost {
  return {
    cwd: ctx.cwd,
    ui: {
      hasUI: ctx.hasUI,
      confirm: (title, message) => ctx.ui.confirm(title, message),
      select: (title, options) => ctx.ui.select(title, [...options]),
      input: (title, placeholder) => ctx.ui.input(title, placeholder),
      editor: (title, prefill) => ctx.ui.editor(title, prefill),
      notify: (message, level) => ctx.ui.notify(message, level),
    },
    notify: (message, level) => ctx.ui.notify(message, level),
    appendRunEntry: (run) => pi.appendEntry("pi-loops.run", conciseRunEntry(run)),
  };
}
