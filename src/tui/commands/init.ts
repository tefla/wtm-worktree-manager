import path from "node:path";
import { findRepositoryRoot } from "../lib/git";
import { ensureProjectStructure, projectStructureExists } from "../services/projectStructure";

export interface InitCommandOptions {
  projectPath: string;
}

export async function runInitCommand(options: InitCommandOptions): Promise<void> {
  const { projectPath } = options;
  const repoRoot = await findRepositoryRoot(projectPath);

  if (!repoRoot) {
    console.error("[wtm] This command must be run inside a git repository.");
    process.exitCode = 1;
    return;
  }

  if (await projectStructureExists(repoRoot)) {
    console.log(`[wtm] Project already initialised at ${path.join(repoRoot, ".wtm")}`);
    return;
  }

  const structure = await ensureProjectStructure(repoRoot);
  console.log(`[wtm] Initialised project at ${structure.wtmPath}`);
}
