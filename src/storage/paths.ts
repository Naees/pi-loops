import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface DataRootOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
}

export function resolvePiAgentDirectory(options: DataRootOptions = {}): string {
  const environment = options.environment ?? process.env;
  const configured = environment.PI_CODING_AGENT_DIR;
  if (configured && configured.trim().length > 0) return resolve(configured);
  return join(options.homeDirectory ?? homedir(), ".pi", "agent");
}

export function resolvePiLoopsDataRoot(options: DataRootOptions = {}): string {
  return join(resolvePiAgentDirectory(options), "pi-loops");
}
