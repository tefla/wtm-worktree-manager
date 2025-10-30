import type {
  EnsureTerminalResponse,
  ProjectConfig,
  ProjectOpenDialogRequest,
  ProjectOpenPathRequest,
  ProjectState,
  ProjectUpdateConfigRequest,
  WorkspaceCreateRequest,
  WorkspaceDeleteRequest,
  WorkspaceDeleteResponse,
  WorkspaceListBranchesResponse,
  WorkspaceSummary,
  WorkspacePathRequest,
  WorkspaceStateResponse,
} from "../../shared/ipc";
import type { DockerComposeServicesSnapshot } from "../../shared/dockerCompose";
import type { TerminalDataPayload, TerminalExitPayload } from "../types";
import type { JiraTicketSummary } from "../../shared/jira";

type ListenerDisposer = () => void;

export const workspaceAPI = {
  list: (): Promise<WorkspaceSummary[]> => window.workspaceAPI.list(),
  create: (params: WorkspaceCreateRequest): Promise<WorkspaceSummary> => window.workspaceAPI.create(params),
  delete: (params: WorkspaceDeleteRequest): Promise<WorkspaceDeleteResponse> =>
    window.workspaceAPI.delete(params),
  refresh: (params: WorkspacePathRequest): Promise<WorkspaceSummary> => window.workspaceAPI.refresh(params),
  update: (params: WorkspacePathRequest): Promise<WorkspaceSummary> => window.workspaceAPI.update(params),
  listBranches: (): Promise<WorkspaceListBranchesResponse> => window.workspaceAPI.listBranches(),
};

export const projectAPI = {
  getCurrent: (): Promise<ProjectState | null> => window.projectAPI.getCurrent(),
  openPath: (params: ProjectOpenPathRequest): Promise<ProjectState | null> => window.projectAPI.openPath(params),
  openDialog: (params?: ProjectOpenDialogRequest): Promise<ProjectState | null> =>
    window.projectAPI.openDialog(params),
  listComposeServices: (): Promise<DockerComposeServicesSnapshot> => window.projectAPI.listComposeServices(),
  updateConfig: (params: ProjectUpdateConfigRequest): Promise<ProjectState> => window.projectAPI.updateConfig(params),
};

export const terminalAPI = {
  ensureSession: (params: {
    workspacePath: string;
    slot: string;
    command?: string;
    args?: string[];
    cols?: number;
    rows?: number;
    env?: Record<string, string>;
    label?: string;
  }): Promise<EnsureTerminalResponse> => window.terminalAPI.ensureSession(params),
  write: (sessionId: string, data: string): void => window.terminalAPI.write(sessionId, data),
  resize: (sessionId: string, cols: number, rows: number): Promise<void> =>
    window.terminalAPI.resize(sessionId, cols, rows),
  dispose: (sessionId: string, options?: Record<string, unknown>): Promise<void> =>
    window.terminalAPI.dispose(sessionId, options),
  release: (sessionId: string): Promise<void> => window.terminalAPI.release(sessionId),
  listForWorkspace: (workspacePath: string): Promise<Record<string, { history: string }>> =>
    window.terminalAPI.listForWorkspace(workspacePath),
  getWorkspaceState: (workspacePath: string): Promise<WorkspaceStateResponse> =>
    window.terminalAPI.getWorkspaceState(workspacePath),
  listSavedWorkspaces: (): Promise<string[]> => window.terminalAPI.listSavedWorkspaces(),
  markQuickCommand: (workspacePath: string, slot: string): Promise<void> =>
    window.terminalAPI.markQuickCommand(workspacePath, slot),
  setActiveTerminal: (workspacePath: string, slot: string | null): Promise<void> =>
    window.terminalAPI.setActiveTerminal(workspacePath, slot),
  clearWorkspaceState: (workspacePath: string): Promise<void> =>
    window.terminalAPI.clearWorkspaceState(workspacePath),
  onData: (callback: (payload: TerminalDataPayload) => void): ListenerDisposer =>
    window.terminalAPI.onData(callback),
  onExit: (callback: (payload: TerminalExitPayload) => void): ListenerDisposer =>
    window.terminalAPI.onExit(callback),
};

export const jiraAPI = {
  listTickets: (params?: { forceRefresh?: boolean }): Promise<JiraTicketSummary[]> =>
    window.jiraAPI.listTickets(params),
  searchTickets: (params: { query: string; limit?: number; forceRefresh?: boolean }): Promise<JiraTicketSummary[]> =>
    window.jiraAPI.searchTickets(params),
};

export const wtmEnv = {
  getE2EProjectPath: (): string | null => window.wtmEnv?.e2eProjectPath ?? null,
};
