import { describe, expect, it } from "vitest";
import { nextRecurringFireAt, parseScheduleExpression } from "../../src/scheduler/parser.js";

const now = new Date("2026-07-12T12:00:00.000Z");
const options = { now, minimumRecurringMs: 5 * 60_000 };

describe("schedule expression parser", () => {
  it("parses and normalizes relative one-off schedules", () => {
    expect(parseScheduleExpression("in 2h", options)).toEqual({
      expression: "in 2h",
      normalizedExpression: "in 2 hours (2026-07-12T14:00:00.000Z)",
      nextFireAt: "2026-07-12T14:00:00.000Z",
      timing: { kind: "once", fireAt: "2026-07-12T14:00:00.000Z" },
    });
  });

  it("parses recurring schedules at the configured minimum", () => {
    expect(parseScheduleExpression("every 5 minutes", options)).toEqual({
      expression: "every 5 minutes",
      normalizedExpression: "every 5 minutes",
      nextFireAt: "2026-07-12T12:05:00.000Z",
      timing: { kind: "recurring", intervalMs: 300_000, anchorAt: now.toISOString() },
    });
    expect(() => parseScheduleExpression("every 4m", options)).toThrow("at least 300000ms");
  });

  it("interprets local clock times as the next future occurrence", () => {
    const localNow = new Date(2026, 6, 12, 13, 30, 0, 0);
    const later = parseScheduleExpression("at 14:00", { ...options, now: localNow });
    const tomorrow = parseScheduleExpression("13:00", { ...options, now: localNow });

    expect(new Date(later.nextFireAt).getDate()).toBe(12);
    expect(new Date(later.nextFireAt).getHours()).toBe(14);
    expect(new Date(tomorrow.nextFireAt).getDate()).toBe(13);
    expect(new Date(tomorrow.nextFireAt).getHours()).toBe(13);
  });

  it("advances recurring schedules from before, at, and after their anchor", () => {
    expect(nextRecurringFireAt("2026-07-12T12:00:00.000Z", 300_000, new Date("2026-07-12T11:59:00.000Z")))
      .toBe("2026-07-12T12:00:00.000Z");
    expect(nextRecurringFireAt("2026-07-12T12:00:00.000Z", 300_000, new Date("2026-07-12T12:00:00.000Z")))
      .toBe("2026-07-12T12:05:00.000Z");
    expect(nextRecurringFireAt("2026-07-12T12:00:00.000Z", 300_000, new Date("2026-07-12T12:16:00.000Z")))
      .toBe("2026-07-12T12:20:00.000Z");
  });

  it("rejects invalid clocks, recurrence limits, and recurrence timing", () => {
    expect(() => parseScheduleExpression("in 1m", { ...options, now: new Date(Number.NaN) })).toThrow("clock must be a valid date");
    for (const minimumRecurringMs of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(() => parseScheduleExpression("in 1m", { now, minimumRecurringMs })).toThrow("positive safe integer");
    }
    for (const [anchorAt, intervalMs, after] of [
      ["not-a-date", 300_000, now],
      [now.toISOString(), 0, now],
      [now.toISOString(), 1.5, now],
      [now.toISOString(), 300_000, new Date(Number.NaN)],
    ] as const) {
      expect(() => nextRecurringFireAt(anchorAt, intervalMs, after)).toThrow("Invalid recurring schedule timing");
    }
  });

  it.each(["", "in 0m", "in -1h", "every 1.5h", "every 999999999999999999999d", "tomorrow", "at 25:00", "in 2h trailing"])(
    "rejects malformed or ambiguous expression %j",
    (expression) => expect(() => parseScheduleExpression(expression, options)).toThrow(),
  );
});
