export const FORBIDDEN_PACKAGE_PREFIXES = Object.freeze([
  ".project-design/",
  ".pi-subagents/",
  "tests/",
  "coverage/",
]);

export const REQUIRED_PACKAGE_PATHS = Object.freeze([
  "docs/integrations.md",
  "docs/operations.md",
  "skills/pi-loops/SKILL.md",
  "src/extension/index.ts",
]);

export function packageFilePaths(files) {
  return files.flatMap((file) => {
    const path = typeof file === "string" ? file : file?.path;
    return typeof path === "string" ? [path] : [];
  });
}

export function findForbiddenPackagePaths(files) {
  return packageFilePaths(files)
    .filter((path) => FORBIDDEN_PACKAGE_PREFIXES.some((prefix) => path.startsWith(prefix)));
}

export function findMissingPackagePaths(files) {
  const paths = new Set(packageFilePaths(files));
  return REQUIRED_PACKAGE_PATHS.filter((path) => !paths.has(path));
}
