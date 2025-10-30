import { contextBridge, ipcRenderer } from "electron";
import type {
  EnsureTerminalResponse,
  ProjectConfig,
  ProjectOpenDialogRequest,
  ProjectOpenPathRequest,
  ProjectState,
  ProjectUpdateConfigRequest,
  TerminalDataPayload,
  TerminalExitPayload,
  WorkspaceCreateRequest,
  WorkspaceDeleteRequest,
  WorkspaceDeleteResponse,
  WorkspaceListBranchesResponse,
  WorkspacePathRequest,
  WorkspaceStateResponse,
  WorkspaceSummary,
} from "../shared/ipc";
import type { DockerComposeServicesSnapshot } from "../shared/dockerCompose";
import type { JiraTicketSummary } from "../shared/jira";
import type { AgentEvent, AgentRequest } from "../shared/agent";

type ListenerDisposer = () => void;

type WorkspaceAPI = {
  list: () => Promise<WorkspaceSummary[]>;
  create: (params: WorkspaceCreateRequest) => Promise<WorkspaceSummary>;
  delete: (params: WorkspaceDeleteRequest) => Promise<WorkspaceDeleteResponse>;
  refresh: (params: WorkspacePathRequest) => Promise<WorkspaceSummary>;
  update: (params: WorkspacePathRequest) => Promise<WorkspaceSummary>;
  listBranches: () => Promise<WorkspaceListBranchesResponse>;
};

type ProjectAPI = {
  getCurrent: () => Promise<ProjectState | null>;
  openPath: (params: ProjectOpenPathRequest) => Promise<ProjectState | null>;
  openDialog: (params?: ProjectOpenDialogRequest) => Promise<ProjectState | null>;
  listComposeServices: () => Promise<DockerComposeServicesSnapshot>;
  updateConfig: (params: ProjectUpdateConfigRequest) => Promise<ProjectState>;
};

type TerminalAPI = {
  ensureSession: (params: {
    workspacePath: string;
    slot: string;
    command?: string;
    args?: string[];
    cols?: number;
    rows?: number;
    env?: NodeJS.ProcessEnv;
    label?: string;
  }) => Promise<EnsureTerminalResponse>;
  write: (sessionId: string, data: string) => void;
  resize: (sessionId: string, cols: number, rows: number) => Promise<void>;
  dispose: (sessionId: string, options?: { skipPersist?: boolean; preserve?: boolean }) => Promise<void>;
  release: (sessionId: string) => Promise<void>;
  listForWorkspace: (workspacePath: string) => Promise<Record<string, { history: string }>>;
  getWorkspaceState: (workspacePath: string) => Promise<WorkspaceStateResponse>;
  listSavedWorkspaces: () => Promise<string[]>;
  markQuickCommand: (workspacePath: string, slot: string) => Promise<void>;
  setActiveTerminal: (workspacePath: string, slot: string | null) => Promise<void>;
  clearWorkspaceState: (workspacePath: string) => Promise<void>;
  onData: (callback: (payload: TerminalDataPayload) => void) => ListenerDisposer;
  onExit: (callback: (payload: TerminalExitPayload) => void) => ListenerDisposer;
};

type JiraAPI = {
  listTickets: (params?: { forceRefresh?: boolean }) => Promise<JiraTicketSummary[]>;
  searchTickets: (params: { query: string; limit?: number; forceRefresh?: boolean }) => Promise<JiraTicketSummary[]>;
};

type AgentAPI = {
  sendMessage: (params: AgentRequest) => Promise<{ requestId: string; messageId: string }>;
  resetSession: () => Promise<{ success: boolean }>;
  onEvent: (callback: (event: AgentEvent) => void) => ListenerDisposer;
};

const invoke = (channel: string, payload?: unknown) => ipcRenderer.invoke(channel, payload);
const addListener = <T>(channel: string, callback: (payload: T) => void): ListenerDisposer => {
  const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload as T);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
};

contextBridge.exposeInMainWorld("wtmEnv", {
  e2eProjectPath: process.env.WTM_E2E_PROJECT_PATH ?? null,
});

contextBridge.exposeInMainWorld("workspaceAPI", {
  list: () => invoke("workspace:list"),
  create: (params) => invoke("workspace:create", params),
  delete: (params) => invoke("workspace:delete", params),
  refresh: (params) => invoke("workspace:refresh", params),
  update: (params) => invoke("workspace:update", params),
  listBranches: () => invoke("workspace:listBranches"),
} satisfies WorkspaceAPI);

contextBridge.exposeInMainWorld("projectAPI", {
  getCurrent: () => invoke("project:getCurrent"),
  openPath: (params) => invoke("project:openPath", params),
  openDialog: (params) => invoke("project:openDialog", params),
  listComposeServices: () => invoke("project:listComposeServices"),
  updateConfig: (params) => invoke("project:updateConfig", params),
} satisfies ProjectAPI);

contextBridge.exposeInMainWorld("terminalAPI", {
  ensureSession: (params) => invoke("terminal:ensure", params),
  write: (sessionId, data) => ipcRenderer.send("terminal:write", { sessionId, data }),
  resize: (sessionId, cols, rows) => invoke("terminal:resize", { sessionId, cols, rows }),
  dispose: (sessionId, options) => invoke("terminal:dispose", { sessionId, options }),
  release: (sessionId) => invoke("terminal:release", { sessionId }),
  listForWorkspace: (workspacePath) => invoke("terminal:listForWorkspace", { workspacePath }),
  getWorkspaceState: (workspacePath) => invoke("terminal:getWorkspaceState", { workspacePath }),
  listSavedWorkspaces: () => invoke("terminal:listSavedWorkspaces"),
  markQuickCommand: (workspacePath, slot) => invoke("terminal:markQuickCommand", { workspacePath, slot }),
  setActiveTerminal: (workspacePath, slot) => invoke("terminal:setActiveTerminal", { workspacePath, slot }),
  clearWorkspaceState: (workspacePath) => invoke("terminal:clearWorkspaceState", { workspacePath }),
  onData: (callback) => addListener("terminal:data", callback),
  onExit: (callback) => addListener("terminal:exit", callback),
} satisfies TerminalAPI);

contextBridge.exposeInMainWorld("jiraAPI", {
  listTickets: (params) => invoke("jira:listTickets", params),
  searchTickets: (params) => invoke("jira:searchTickets", params),
} satisfies JiraAPI);

contextBridge.exposeInMainWorld("agentAPI", {
  sendMessage: (params: AgentRequest) => invoke("agent:sendMessage", params),
  resetSession: () => invoke("agent:resetSession"),
  onEvent: (callback: (event: AgentEvent) => void) => addListener<AgentEvent>("agent:event", callback),
} satisfies AgentAPI);

declare global {
  interface Window {
    workspaceAPI: WorkspaceAPI;
    projectAPI: ProjectAPI;
    terminalAPI: TerminalAPI;
    jiraAPI: JiraAPI;
    agentAPI: AgentAPI;
    wtmEnv?: {
      e2eProjectPath: string | null;
    };
  }
}
