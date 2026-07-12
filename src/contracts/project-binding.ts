import { realpath } from "node:fs/promises";
import { createProjectId } from "../shared/ids.js";

export interface ProjectBinding {
  readonly projectRoot: string;
  readonly projectId: string;
}

export async function resolveProjectBinding(cwd: string): Promise<ProjectBinding> {
  const projectRoot = await realpath(cwd);
  return { projectRoot, projectId: createProjectId(projectRoot) };
}
