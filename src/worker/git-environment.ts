const REPOSITORY_SHAPING_VARIABLES = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_DIR",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_INDEX_FILE",
  "GIT_NAMESPACE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_WORK_TREE",
] as const;

export function sanitizedGitEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const sanitized = { ...environment };
  const fixedNames = new Set<string>(REPOSITORY_SHAPING_VARIABLES);
  for (const name of Object.keys(sanitized)) {
    const normalized = name.toUpperCase();
    if (fixedNames.has(normalized) || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(normalized)) delete sanitized[name];
  }
  sanitized.GIT_OPTIONAL_LOCKS = "0";
  sanitized.GIT_TERMINAL_PROMPT = "0";
  sanitized.LC_ALL = "C";
  return sanitized;
}
