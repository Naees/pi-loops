import { describe, expect, it } from "vitest";
import { sanitizedGitEnvironment } from "../../src/worker/git-environment.js";

describe("sanitized Git environment", () => {
  it("removes repository-shaping overrides while preserving unrelated variables", () => {
    expect(sanitizedGitEnvironment({
      PATH: "/usr/bin",
      Git_Dir: "/tmp/redirected",
      git_work_tree: "/tmp/worktree",
      GIT_COMMON_DIR: "/tmp/common",
      GIT_INDEX_FILE: "/tmp/index",
      GIT_CEILING_DIRECTORIES: "/tmp",
      GIT_CONFIG_COUNT: "1",
      git_config_key_0: "core.hooksPath",
      Git_Config_Value_0: "/tmp/hooks",
      GIT_OBJECT_DIRECTORY: "/tmp/objects",
      GIT_ALTERNATE_OBJECT_DIRECTORIES: "/tmp/alternate",
    })).toEqual({
      PATH: "/usr/bin",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
    });
  });
});
