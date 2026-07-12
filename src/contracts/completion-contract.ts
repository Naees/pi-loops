export interface VerifierSpec {
  readonly id: string;
  readonly command: string;
  readonly description: string;
  readonly required: true;
}

export interface CompletionContract {
  readonly schemaVersion: 1;
  readonly goal: string;
  readonly constraints: readonly string[];
  readonly verifiers: readonly VerifierSpec[];
}

const MAX_GOAL_BYTES = 16 * 1024;
const MAX_ITEM_BYTES = 4 * 1024;
const MAX_VERIFIERS = 20;
const MAX_CONSTRAINTS = 50;

function nonEmpty(name: string, value: string, maxBytes: number): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} must not be empty`);
  if (Buffer.byteLength(normalized, "utf8") > maxBytes) throw new Error(`${name} must be at most ${maxBytes} UTF-8 bytes`);
  return normalized;
}

export function createCompletionContract(
  goal: string,
  verifierCommands: readonly string[] = [],
  constraints: readonly string[] = [],
): CompletionContract {
  const normalizedGoal = nonEmpty("Goal", goal, MAX_GOAL_BYTES);
  if (verifierCommands.length > MAX_VERIFIERS) throw new Error(`At most ${MAX_VERIFIERS} verifier commands are allowed`);
  if (constraints.length > MAX_CONSTRAINTS) throw new Error(`At most ${MAX_CONSTRAINTS} constraints are allowed`);
  const commands = [...new Set(verifierCommands.map((command) => nonEmpty("Verifier command", command, MAX_ITEM_BYTES)))];
  const normalizedConstraints = [...new Set(constraints.map((constraint) => nonEmpty("Constraint", constraint, MAX_ITEM_BYTES)))];

  return {
    schemaVersion: 1,
    goal: normalizedGoal,
    constraints: normalizedConstraints,
    verifiers: commands.map((command, index) => ({
      id: `verifier_${index + 1}`,
      command,
      description: `Command exits successfully: ${command}`,
      required: true,
    })),
  };
}

export function inferBacktickedVerifierCommands(goal: string): string[] {
  const commands: string[] = [];
  const pattern = /`([^`\n]+)`/g;
  for (const match of goal.matchAll(pattern)) {
    const candidate = match[1]?.trim();
    if (!candidate) continue;
    const surrounding = goal.slice(Math.max(0, (match.index ?? 0) - 40), Math.min(goal.length, (match.index ?? 0) + match[0].length + 40));
    const nearVerificationLanguage = /\b(pass|passes|passing|exit|exits|succeed|succeeds|successful|verify|check|run)\b/i.test(surrounding);
    const looksLikeCommand = /^(?:npm\s|npx\s|pnpm\s|yarn\s|bun\s|node\s|deno\s|python\s|python3\s|pytest(?:\s|$)|go\s|cargo\s|make(?:\s|$)|tsc(?:\s|$)|eslint(?:\s|$)|vitest(?:\s|$))/.test(candidate);
    if (nearVerificationLanguage && looksLikeCommand) commands.push(candidate);
  }
  return [...new Set(commands)];
}
