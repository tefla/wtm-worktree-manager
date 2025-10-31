import React from "react";
import { findRepositoryRoot } from "../lib/git";
import { confirmPrompt } from "../lib/prompt";
import { WorkspaceManager } from "../../core/workspaceManager";
import { ensureProjectStructure, getProjectStructure, projectStructureExists } from "../services/projectStructure";
import { App } from "../ui/App";

export interface RunTuiOptions {
  projectPath: string;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
}

export async function runTui(options: RunTuiOptions): Promise<void> {
  const loadModule = new Function(
    "specifier",
    "return import(specifier);",
  ) as <T>(specifier: string) => Promise<T>;

  const repoRoot = await findRepositoryRoot(options.projectPath);

  if (!repoRoot) {
    console.error("[wtm] Unable to locate git repository from current directory.");
    process.exitCode = 1;
    return;
  }

  if (!(await projectStructureExists(repoRoot))) {
    const shouldInit = await confirmPrompt("No .wtm project found. Run 'wtm init' now?", true);
    if (!shouldInit) {
      console.log("[wtm] Aborting. Initialise the project with 'wtm init' to continue.");
      return;
    }
    await ensureProjectStructure(repoRoot);
  }

  const structure = await getProjectStructure(repoRoot);
  if (!structure) {
    console.error("[wtm] Failed to read project structure after initialisation.");
    process.exitCode = 1;
    return;
  }

  const workspaceManager = new WorkspaceManager({
    repoDir: structure.projectPath,
    workspaceRoot: structure.workspacesPath,
  });

  const ink = await loadModule<typeof import("ink")>("ink");

  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  const instance = ink.render(
    <App
      projectPath={repoRoot}
      structure={structure}
      workspaceManager={workspaceManager}
      ink={ink}
    />,
    {
      stdin,
      stdout,
      stderr,
      exitOnCtrlC: true,
    },
  );

  await instance.waitUntilExit();
}
