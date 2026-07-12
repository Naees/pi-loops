import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { commandHelp, conciseRunEntry, formatScheduleStatus, formatTriggerStatus, lastAssistantText, toolResult } from "../../src/extension/presentation.js";
import type { RunRecord, ScheduleRecord, TriggerRecord } from "../../src/shared/types.js";

const run: RunRecord = {
  schemaVersion: 1,
  runId: "run_1234abcd",
  projectId: "project_1234567890abcdef",
  mode: "goal",
  state: "running",
  goal: "finish",
  budget: { maxActiveMs: 60_000, maxCycles: 2, stallThreshold: 2 },
  cycle: 1,
  totalCycles: 3,
  createdAt: "2026-07-12T00:00:00.000Z",
  updatedAt: "2026-07-12T00:01:00.000Z",
  transitions: [],
};

const schedule: ScheduleRecord = {
  schemaVersion: 1,
  scheduleId: "schedule_1234abcd",
  projectId: "project_1234567890abcdef",
  projectRoot: "/tmp/project",
  state: "running",
  goal: "check CI",
  constraints: [],
  verifierCommands: [],
  budget: { maxActiveMs: 60_000, maxCycles: 2, stallThreshold: 2 },
  expression: "every 5m",
  normalizedExpression: "every 5 minutes",
  timing: { kind: "recurring", intervalMs: 300_000, anchorAt: "2026-07-12T00:00:00.000Z" },
  nextFireAt: "2026-07-12T00:05:00.000Z",
  activeRunId: "run_1234abcd",
  createdAt: "2026-07-12T00:00:00.000Z",
  updatedAt: "2026-07-12T00:01:00.000Z",
};

describe("extension presentation", () => {
  it("keeps transcript and tool details concise", () => {
    expect(conciseRunEntry(run)).toEqual({
      schemaVersion: 1,
      runId: run.runId,
      state: "running",
      cycle: 1,
      totalCycles: 3,
      updatedAt: run.updatedAt,
    });
    expect(toolResult("started", run)).toEqual(expect.objectContaining({
      content: [{ type: "text", text: "started" }],
      details: expect.objectContaining({ runId: run.runId }),
      terminate: true,
    }));
  });

  it("formats schedule and trigger state with command help", () => {
    expect(formatScheduleStatus(schedule)).toContain("schedule_1234abcd  running");
    expect(formatScheduleStatus(schedule)).toContain("next 2026-07-12T00:05:00.000Z active run_1234abcd — check CI");
    const trigger: TriggerRecord = {
      schemaVersion: 1,
      triggerId: "trigger_1234abcd",
      projectId: schedule.projectId,
      projectRoot: schedule.projectRoot,
      state: "enabled",
      goal: "regenerate",
      constraints: [],
      verifierCommands: [],
      budget: schedule.budget,
      source: { kind: "filesystem", relativePath: "src", debounceMs: 1_000 },
      createdAt: schedule.createdAt,
      updatedAt: schedule.updatedAt,
    };
    expect(formatTriggerStatus(trigger)).toBe("trigger_1234abcd  enabled  watch src — regenerate");
    expect(commandHelp()).toContain("/loops schedule <time-expression> -- <goal>");
    expect(commandHelp()).toContain("/loops watch <project-path|event> -- <goal>");
  });

  it("uses the most recent non-empty assistant text", () => {
    const context = {
      sessionManager: {
        getBranch: () => [
          { type: "message", message: { role: "assistant", content: [{ type: "text", text: "first" }] } },
          { type: "message", message: { role: "user", content: "ignored" } },
          { type: "message", message: { role: "assistant", content: [{ type: "text", text: "latest" }] } },
        ],
      },
    } as unknown as Pick<ExtensionContext, "sessionManager">;
    expect(lastAssistantText(context)).toBe("latest");
  });
});
