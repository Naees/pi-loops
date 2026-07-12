import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEFAULT_CONFIG } from "../config/config.js";

const CHILD_MARKER = "PI_LOOPS_CHILD";

function statusText(): string {
  return [
    "Pi Loops foundation is loaded.",
    "Active runs: 0",
    `Default budget: ${DEFAULT_CONFIG.defaults.maxCycles} cycles / ${DEFAULT_CONFIG.defaults.maxActiveMs / 3_600_000} hours`,
    "Goal execution will be enabled in Phase 1.",
  ].join("\n");
}

export default function piLoopsExtension(pi: ExtensionAPI): void {
  if (process.env[CHILD_MARKER]) {
    return;
  }

  pi.registerCommand("loops", {
    description: "Control bounded Pi Loops workflows",
    handler: async (args, ctx) => {
      const [subcommand] = args.trim().split(/\s+/, 1);
      if (!subcommand || subcommand === "status") {
        ctx.ui.notify(statusText(), "info");
        return;
      }

      if (subcommand === "help") {
        ctx.ui.notify("Available during Phase 0: /loops status", "info");
        return;
      }

      ctx.ui.notify(`Pi Loops subcommand is not implemented yet: ${subcommand}`, "warning");
    },
  });

  pi.registerTool({
    name: "pi_loops",
    label: "Pi Loops",
    description: "Inspect bounded Pi Loops workflow status. Goal execution is not enabled in this development build.",
    promptSnippet: "Inspect Pi Loops workflow status",
    promptGuidelines: [
      "Use pi_loops only to inspect loop status until goal execution is enabled.",
    ],
    parameters: Type.Object({
      action: StringEnum(["status"] as const, { description: "Status action" }),
    }),
    async execute() {
      return {
        content: [{ type: "text", text: statusText() }],
        details: {
          phase: 0,
          activeRuns: 0,
          defaults: DEFAULT_CONFIG.defaults,
        },
      };
    },
  });
}
