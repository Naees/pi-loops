export type ParsedScheduleTiming =
  | { readonly kind: "once"; readonly fireAt: string }
  | { readonly kind: "recurring"; readonly intervalMs: number; readonly anchorAt: string };

export interface ParsedScheduleExpression {
  readonly expression: string;
  readonly normalizedExpression: string;
  readonly nextFireAt: string;
  readonly timing: ParsedScheduleTiming;
}

export interface ScheduleParserOptions {
  readonly now?: Date;
  readonly minimumRecurringMs: number;
}

const DURATION_PATTERN = /^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i;
const LOCAL_TIME_PATTERN = /^(?:at\s+)?([01]\d|2[0-3]):([0-5]\d)$/i;

function parseDuration(value: string): { amount: number; unit: "minute" | "hour" | "day"; ms: number } {
  const match = DURATION_PATTERN.exec(value.trim());
  if (!match) throw new Error(`Unsupported schedule duration: ${value}`);
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("Schedule duration must be a positive safe integer");
  const rawUnit = match[2]?.toLowerCase();
  const unit = rawUnit?.startsWith("m") ? "minute" : rawUnit?.startsWith("h") ? "hour" : "day";
  const multiplier = unit === "minute" ? 60_000 : unit === "hour" ? 60 * 60_000 : 24 * 60 * 60_000;
  const ms = amount * multiplier;
  if (!Number.isSafeInteger(ms)) throw new Error("Schedule duration is too large");
  return { amount, unit, ms };
}

function formatDuration(amount: number, unit: "minute" | "hour" | "day"): string {
  return `${amount} ${unit}${amount === 1 ? "" : "s"}`;
}

function assertClock(now: Date): void {
  if (!Number.isFinite(now.getTime())) throw new Error("Schedule clock must be a valid date");
}

export function parseScheduleExpression(input: string, options: ScheduleParserOptions): ParsedScheduleExpression {
  const expression = input.trim();
  if (!expression) throw new Error("Schedule expression must not be empty");
  const now = options.now ?? new Date();
  assertClock(now);
  if (!Number.isSafeInteger(options.minimumRecurringMs) || options.minimumRecurringMs <= 0) {
    throw new Error("Minimum recurring interval must be a positive safe integer");
  }

  const recurring = /^every\s+(.+)$/i.exec(expression);
  if (recurring) {
    const duration = parseDuration(recurring[1] ?? "");
    if (duration.ms < options.minimumRecurringMs) {
      throw new Error(`Recurring schedules must be at least ${options.minimumRecurringMs}ms apart`);
    }
    const nextFireAt = new Date(now.getTime() + duration.ms).toISOString();
    return {
      expression,
      normalizedExpression: `every ${formatDuration(duration.amount, duration.unit)}`,
      nextFireAt,
      timing: { kind: "recurring", intervalMs: duration.ms, anchorAt: now.toISOString() },
    };
  }

  const relative = /^in\s+(.+)$/i.exec(expression);
  if (relative) {
    const duration = parseDuration(relative[1] ?? "");
    const fireAt = new Date(now.getTime() + duration.ms).toISOString();
    return {
      expression,
      normalizedExpression: `in ${formatDuration(duration.amount, duration.unit)} (${fireAt})`,
      nextFireAt: fireAt,
      timing: { kind: "once", fireAt },
    };
  }

  const localTime = LOCAL_TIME_PATTERN.exec(expression);
  if (localTime) {
    const hours = Number(localTime[1]);
    const minutes = Number(localTime[2]);
    const fireAt = new Date(now);
    fireAt.setHours(hours, minutes, 0, 0);
    if (fireAt.getTime() <= now.getTime()) fireAt.setDate(fireAt.getDate() + 1);
    if (fireAt.getHours() !== hours || fireAt.getMinutes() !== minutes) {
      throw new Error(`Local time does not exist on the selected date: ${localTime[1]}:${localTime[2]}`);
    }
    const iso = fireAt.toISOString();
    return {
      expression,
      normalizedExpression: `at ${localTime[1]}:${localTime[2]} local (${iso})`,
      nextFireAt: iso,
      timing: { kind: "once", fireAt: iso },
    };
  }

  throw new Error(`Unsupported schedule expression: ${expression}`);
}

export function nextRecurringFireAt(anchorAt: string, intervalMs: number, after: Date): string {
  const anchorMs = Date.parse(anchorAt);
  const afterMs = after.getTime();
  if (!Number.isFinite(anchorMs) || !Number.isSafeInteger(intervalMs) || intervalMs <= 0 || !Number.isFinite(afterMs)) {
    throw new Error("Invalid recurring schedule timing");
  }
  if (afterMs < anchorMs) return new Date(anchorMs).toISOString();
  const intervals = Math.floor((afterMs - anchorMs) / intervalMs) + 1;
  const nextMs = anchorMs + intervals * intervalMs;
  if (!Number.isSafeInteger(nextMs)) throw new Error("Recurring schedule next occurrence is too large");
  return new Date(nextMs).toISOString();
}
