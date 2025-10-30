import type { BrowserWindow } from "electron";
import type { ProjectState, ProjectUpdateConfigRequest } from "../../shared/ipc";
import { ProjectManager } from "../projectManager";
import type { ProjectConfig } from "../projectConfig";

export type ProjectStateTransform = (state: ProjectState | null) => ProjectState | null;

export class ProjectService {
  private readonly stateTransforms: ProjectStateTransform[] = [];

  constructor(private readonly manager: ProjectManager) {}

  registerStateTransform(transform: ProjectStateTransform): void {
    this.stateTransforms.push(transform);
  }

  private applyTransforms(state: ProjectState | null): ProjectState | null {
    return this.stateTransforms.reduce((acc, transform) => transform(acc), state);
  }

  async getCurrentState(): Promise<ProjectState | null> {
    const state = await this.manager.getCurrentState();
    return this.applyTransforms(state);
  }

  async setCurrentProjectWithPrompt(projectPath: string, browserWindow?: BrowserWindow): Promise<ProjectState | null> {
    const state = await this.manager.setCurrentProjectWithPrompt(projectPath, browserWindow);
    return this.applyTransforms(state);
  }

  async setCurrentProject(projectPath: string): Promise<ProjectState> {
    const state = await this.manager.setCurrentProject(projectPath);
    const transformed = this.applyTransforms(state);
    if (!transformed) {
      throw new Error("Project state transform returned null for a required project");
    }
    return transformed;
  }

  async listComposeServices() {
    return this.manager.listComposeServices();
  }

  async updateConfig(config: ProjectConfig): Promise<ProjectState> {
    const state = await this.manager.updateConfig(config);
    const transformed = this.applyTransforms(state);
    if (!transformed) {
      throw new Error("Project state transform returned null for a required project");
    }
    return transformed;
  }
}
