import { isAbsolute, resolve } from "node:path";

export function npmInvocation(args, environment = process.env, platform = process.platform) {
  const npmCli = environment.npm_execpath;
  if (typeof npmCli === "string" && isAbsolute(npmCli)) {
    return { executable: process.execPath, args: [npmCli, ...args] };
  }
  if (platform === "win32") {
    throw new Error("Windows npm subprocesses require an absolute npm_execpath");
  }
  return { executable: "npm", args: [...args] };
}

export function localVitestInvocation(args, cwd = process.cwd()) {
  return {
    executable: process.execPath,
    args: [resolve(cwd, "node_modules", "vitest", "vitest.mjs"), ...args],
  };
}

export function piInvocation(environment = process.env) {
  const cli = environment.PI_LOOPS_TEST_PI_CLI;
  if (typeof cli === "string" && cli.length > 0) {
    if (!isAbsolute(cli)) throw new Error("PI_LOOPS_TEST_PI_CLI must be absolute");
    return { executable: process.execPath, argsPrefix: [cli] };
  }
  return { executable: environment.PI_LOOPS_TEST_PI ?? "pi", argsPrefix: [] };
}
