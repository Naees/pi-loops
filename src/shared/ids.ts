import { createHash, randomBytes } from "node:crypto";

const RUN_ID_PATTERN = /^run_[0-9a-f]{8}$/;
const SCHEDULE_ID_PATTERN = /^schedule_[0-9a-f]{8}$/;
const PROJECT_ID_PATTERN = /^project_[0-9a-f]{16}$/;

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

export function createRunId(): string {
  return `run_${randomHex(4)}`;
}

export function createScheduleId(): string {
  return `schedule_${randomHex(4)}`;
}

export function isRunId(value: string): boolean {
  return RUN_ID_PATTERN.test(value);
}

export function isScheduleId(value: string): boolean {
  return SCHEDULE_ID_PATTERN.test(value);
}

export function isProjectId(value: string): boolean {
  return PROJECT_ID_PATTERN.test(value);
}

export function createProjectId(canonicalProjectRoot: string): string {
  const digest = createHash("sha256").update(canonicalProjectRoot).digest("hex").slice(0, 16);
  return `project_${digest}`;
}
