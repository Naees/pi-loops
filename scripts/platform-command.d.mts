export interface CommandInvocation {
  readonly executable: string;
  readonly args: string[];
}

export interface PiInvocation {
  readonly executable: string;
  readonly argsPrefix: string[];
}

export function npmInvocation(
  args: readonly string[],
  environment?: NodeJS.ProcessEnv,
  platform?: NodeJS.Platform,
): CommandInvocation;
export function localVitestInvocation(args: readonly string[], cwd?: string): CommandInvocation;
export function piInvocation(environment?: NodeJS.ProcessEnv): PiInvocation;
