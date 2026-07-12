export const FORBIDDEN_PACKAGE_PREFIXES = [
  ".project-design/",
  ".pi-subagents/",
  "tests/",
  "coverage/",
];

export function findForbiddenPackagePaths(files) {
  return files
    .map((file) => typeof file === "string" ? file : file.path)
    .filter((path) => typeof path === "string" && FORBIDDEN_PACKAGE_PREFIXES.some((prefix) => path.startsWith(prefix)));
}
