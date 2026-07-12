import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const MAX_MANIFEST_BYTES = 256 * 1024;

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function packageScripts(projectRoot: string): Promise<Record<string, string>> {
  const path = join(projectRoot, "package.json");
  try {
    const metadata = await stat(path);
    if (metadata.size > MAX_MANIFEST_BYTES) return {};
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    const scripts = (value as Record<string, unknown>).scripts;
    if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) return {};
    return Object.fromEntries(Object.entries(scripts).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return {};
    throw error;
  }
}

function usefulTestScript(script: string | undefined): boolean {
  if (!script?.trim()) return false;
  return !/echo\s+["']?error:\s*no test specified/i.test(script);
}

export async function inferProjectVerifierCommands(projectRoot: string, goal: string): Promise<string[]> {
  const lowerGoal = goal.toLowerCase();
  const scripts = await packageScripts(projectRoot);
  const commands: string[] = [];

  if (usefulTestScript(scripts.test)) commands.push("npm test");
  if (/\b(lint|format|style)\b/.test(lowerGoal) && scripts.lint) commands.push("npm run lint");
  if (/\b(build|compile|bundle|type.?check)\b/.test(lowerGoal)) {
    if (scripts.build) commands.push("npm run build");
    else if (scripts.typecheck) commands.push("npm run typecheck");
  }

  if (commands.length === 0 && /\b(test|tests|testing)\b/.test(lowerGoal)) {
    if (await exists(join(projectRoot, "Cargo.toml"))) commands.push("cargo test");
    else if (await exists(join(projectRoot, "go.mod"))) commands.push("go test ./...");
    else if (await exists(join(projectRoot, "pyproject.toml"))) commands.push("pytest");
  }

  return [...new Set(commands)].slice(0, 3);
}
