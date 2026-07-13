export const FORBIDDEN_PACKAGE_PREFIXES: readonly string[];

export function findForbiddenPackagePaths(
  files: readonly (string | { path?: unknown })[],
): string[];
