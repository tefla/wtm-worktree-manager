import { dialog } from "electron";
import { promises as fs } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  loadProjectConfig,
  saveProjectConfig,
  defaultProjectConfig,
  normaliseProjectConfig,
} from "./projectConfig";
import type { ProjectConfig, QuickAccessEntry } from "./projectConfig";
import { WorkspaceManager } from "./workspaceManager";
import { TerminalSessionStore } from "./terminalSessionStore";
import { DockerComposeInspector } from "./dockerComposeInspector";
import type { DockerComposeServicesSnapshot } from "../shared/dockerCompose";
import type { ProjectState } from "../shared/ipc";

const WTM_FOLDER_NAME = ".wtm";
const CONFIG_FILE_NAME = "config.json";
const WORKSPACES_DIR_NAME = "workspaces";
const TERMINALS_FILE_NAME = "terminals.json";

export interface ProjectContext {
  projectPath: string;
  wtmPath: string;
  configPath: string;
  workspacesPath: string;
  terminalsPath: string;
  config: ProjectConfig;
}

export class MissingProjectStructureError extends Error {
  constructor(public projectPath: string) {
    super(`Project at ${projectPath} does not contain a ${WTM_FOLDER_NAME} folder.`);
    this.name = "MissingProjectStructureError";
  }
}

export class ProjectManager {
  private current: ProjectContext | null;

  constructor(
    private readonly workspaceManager: WorkspaceManager,
    private readonly terminalSessionStore: TerminalSessionStore,
    private readonly dockerComposeInspector: DockerComposeInspector,
  ) {
    this.current = null;
  }

  getCurrent(): ProjectContext | null {
    return this.current;
  }

  async getCurrentState(): Promise<ProjectState | null> {
    if (!this.current) {
      return null;
    }
    return this.buildProjectState(this.current);
  }

  private ensureDirectoryExists = async (target: string) => {
    await mkdir(target, { recursive: true });
  };

  private async readDirExists(target: string): Promise<boolean> {
    try {
      const stats = await fs.stat(target);
      return stats.isDirectory();
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  private async ensureConfig(configPath: string): Promise<ProjectConfig> {
    try {
      return await loadProjectConfig(configPath);
    } catch (error) {
      const defaults = defaultProjectConfig();
      await saveProjectConfig(configPath, defaults);
      return defaults;
    }
  }

  async initialiseProjectStructure(projectPath: string): Promise<ProjectContext> {
    const resolved = resolve(projectPath);
    const wtmPath = join(resolved, WTM_FOLDER_NAME);
    const configPath = join(wtmPath, CONFIG_FILE_NAME);
    const workspacesPath = join(wtmPath, WORKSPACES_DIR_NAME);
    const terminalsPath = join(wtmPath, TERMINALS_FILE_NAME);

    await this.ensureDirectoryExists(wtmPath);
    await this.ensureDirectoryExists(workspacesPath);

    if (!(await this.readDirExists(workspacesPath))) {
      throw new Error(`Failed to create workspaces directory at ${workspacesPath}`);
    }

    const config = await this.ensureConfig(configPath);

    return {
      projectPath: resolved,
      wtmPath,
      configPath,
      workspacesPath,
      terminalsPath,
      config,
    };
  }

  private async loadExistingProject(projectPath: string): Promise<ProjectContext> {
    const resolved = resolve(projectPath);
    const wtmPath = join(resolved, WTM_FOLDER_NAME);
    if (!(await this.readDirExists(wtmPath))) {
      throw new MissingProjectStructureError(resolved);
    }
    const configPath = join(wtmPath, CONFIG_FILE_NAME);
    const workspacesPath = join(wtmPath, WORKSPACES_DIR_NAME);
    const terminalsPath = join(wtmPath, TERMINALS_FILE_NAME);

    await this.ensureDirectoryExists(workspacesPath);

    const config = await this.ensureConfig(configPath);

    return {
      projectPath: resolved,
      wtmPath,
      configPath,
      workspacesPath,
      terminalsPath,
      config,
    };
  }

  private async applyContext(context: ProjectContext): Promise<void> {
    this.current = context;
    this.workspaceManager.configure({
      repoDir: context.projectPath,
      workspaceRoot: context.workspacesPath,
    });
    await this.terminalSessionStore.configure({
      filePath: context.terminalsPath,
    });
  }

  async setCurrentProject(projectPath: string): Promise<ProjectState> {
    const context = await this.loadExistingProject(projectPath);
    await this.applyContext(context);
    return this.buildProjectState(context);
  }

  async setCurrentProjectWithPrompt(projectPath: string, browserWindow?: Electron.BrowserWindow): Promise<ProjectState | null> {
    try {
      return await this.setCurrentProject(projectPath);
    } catch (error) {
      if (error instanceof MissingProjectStructureError) {
        const response = await dialog.showMessageBox(browserWindow ?? null, {
          type: "question",
          buttons: ["Create", "Cancel"],
          defaultId: 0,
          cancelId: 1,
          title: "Create WTM Project Structure",
          message: `The selected project does not contain a ${WTM_FOLDER_NAME} folder.`,
          detail: "Would you like to create a default one now?",
        });
        if (response.response === 0) {
          const context = await this.initialiseProjectStructure(projectPath);
          await this.applyContext(context);
          return this.buildProjectState(context);
        }
        return null;
      }
      throw error;
    }
  }

  async listComposeServices(): Promise<DockerComposeServicesSnapshot> {
    if (!this.current) {
      return { projectName: null, services: [] };
    }
    return this.dockerComposeInspector.inspect(this.current.projectPath);
  }

  async updateConfig(config: ProjectConfig): Promise<ProjectState> {
    if (!this.current) {
      throw new Error("No project selected");
    }
    const normalised = normaliseProjectConfig(config);
    await saveProjectConfig(this.current.configPath, normalised);
    this.current.config = {
      ...normalised,
      quickAccess: normalised.quickAccess.map((entry) => ({ ...entry })),
    };
    return this.buildProjectState(this.current);
  }

  private async buildProjectState(context: ProjectContext): Promise<ProjectState> {
    const composeSnapshot = await this.dockerComposeInspector.inspect(context.projectPath);
    return {
      projectPath: context.projectPath,
      projectName: basename(context.projectPath) || context.projectPath,
      quickAccess: context.config.quickAccess,
      composeProjectName: composeSnapshot.projectName,
      composeServices: composeSnapshot.services,
      ...(composeSnapshot.error ? { composeError: composeSnapshot.error } : {}),
    };
  }
}
