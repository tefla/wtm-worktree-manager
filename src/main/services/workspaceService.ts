import type {
  WorkspaceSummary,
  WorkspaceDeleteRequest,
  WorkspaceDeleteResponse,
  WorkspaceCreateRequest,
  WorkspaceListBranchesResponse,
} from "../../shared/ipc";
import { WorkspaceManager } from "../workspaceManager";

export type WorkspaceListTransform = (workspaces: WorkspaceSummary[]) => WorkspaceSummary[];

export class WorkspaceService {
  private readonly listTransforms: WorkspaceListTransform[] = [];

  constructor(private readonly manager: WorkspaceManager) {}

  registerListTransform(transform: WorkspaceListTransform): void {
    this.listTransforms.push(transform);
  }

  private applyListTransforms(list: WorkspaceSummary[]): WorkspaceSummary[] {
    return this.listTransforms.reduce((acc, transform) => transform(acc), list);
  }

  async listWorkspaces(): Promise<WorkspaceSummary[]> {
    const list = await this.manager.listWorkspaces();
    return this.applyListTransforms(list);
  }

  async listBranches(): Promise<WorkspaceListBranchesResponse> {
    return this.manager.listBranches();
  }

  async createWorkspace(params: WorkspaceCreateRequest): Promise<WorkspaceSummary> {
    return this.manager.createWorkspace(params);
  }

  async deleteWorkspace(params: WorkspaceDeleteRequest): Promise<WorkspaceDeleteResponse> {
    return this.manager.deleteWorkspace(params);
  }

  async refreshWorkspace(path: string): Promise<WorkspaceSummary> {
    return this.manager.refreshWorkspace(path);
  }

  async updateWorkspace(path: string): Promise<WorkspaceSummary> {
    return this.manager.updateWorkspace(path);
  }

  async ensureWorkspaceRoot(): Promise<void> {
    await this.manager.ensureWorkspaceRoot();
  }
}
