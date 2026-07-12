import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CurrentModelEvaluator } from "../../src/evidence/evaluator.js";

export default function evaluatorSpike(pi: ExtensionAPI): void {
  pi.registerCommand("pi-loops-evaluator-spike", {
    description: "Internal Pi Loops evaluator integration spike",
    handler: async (_args, ctx) => {
      try {
        const evaluator = new CurrentModelEvaluator(ctx);
        const decision = await evaluator.evaluate({
          goal: "Confirm that the supplied deterministic criterion passed.",
          constraints: ["Use only the supplied evidence."],
          workerSummary: "The deterministic check completed successfully.",
          verifierEvidence: [
            {
              criterion: "The controlled check reports PASS.",
              passed: true,
              summary: "PASS",
            },
          ],
        });
        ctx.ui.notify(`PI_LOOPS_EVALUATOR_SPIKE_OK ${JSON.stringify(decision)}`, "info");
      } catch (error) {
        ctx.ui.notify(`PI_LOOPS_EVALUATOR_SPIKE_ERROR ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
