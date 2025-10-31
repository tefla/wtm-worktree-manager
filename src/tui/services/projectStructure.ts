import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { defaultProjectConfig, saveProjectConfig } from "../../core/projectConfig";

export const WTM_FOLDER_NAME = ".wtm";
export const CONFIG_FILE_NAME = "config.json";
export const WORKSPACES_DIR_NAME = "workspaces";
export const TERMINALS_FILE_NAME = "terminals.json";

export interface ProjectStructure {
  projectPath: string;
  wtmPath: string;
  configPath: string;
  workspacesPath: string;
  terminalsPath: string;
}

export async function projectStructureExists(projectPath: string): Promise<boolean> {
  try {
    const stats = await stat(path.join(projectPath, WTM_FOLDER_NAME));
    return stats.isDirectory();
  } catch {
    return false;
  }
}

async function ensureConfigFile(configPath: string): Promise<void> {
  try {
    await stat(configPath);
  } catch {
    const defaults = defaultProjectConfig();
    await saveProjectConfig(configPath, defaults);
  }
}

export async function ensureProjectStructure(projectPath: string): Promise<ProjectStructure> {
  const resolved = path.resolve(projectPath);
  const wtmPath = path.join(resolved, WTM_FOLDER_NAME);
  const configPath = path.join(wtmPath, CONFIG_FILE_NAME);
  const workspacesPath = path.join(wtmPath, WORKSPACES_DIR_NAME);
  const terminalsPath = path.join(wtmPath, TERMINALS_FILE_NAME);

  await mkdir(wtmPath, { recursive: true });
  await mkdir(workspacesPath, { recursive: true });
  await ensureConfigFile(configPath);

  return {
    projectPath: resolved,
    wtmPath,
    configPath,
    workspacesPath,
    terminalsPath,
  };
}

export async function getProjectStructure(projectPath: string): Promise<ProjectStructure | null> {
  const resolved = path.resolve(projectPath);
  if (!(await projectStructureExists(resolved))) {
    return null;
  }
  const wtmPath = path.join(resolved, WTM_FOLDER_NAME);
  const configPath = path.join(wtmPath, CONFIG_FILE_NAME);
  const workspacesPath = path.join(wtmPath, WORKSPACES_DIR_NAME);
  const terminalsPath = path.join(wtmPath, TERMINALS_FILE_NAME);
  return {
    projectPath: resolved,
    wtmPath,
    configPath,
    workspacesPath,
    terminalsPath,
  };
}
