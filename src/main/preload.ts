import { contextBridge, ipcRenderer } from "electron";

type ListenerDisposer = () => void;

type WorkspaceAPI = {
  list: () => Promise<unknown>;
  create: (params: unknown) => Promise<unknown>;
  delete: (params: unknown) => Promise<unknown>;
  refresh: (params: unknown) => Promise<unknown>;
  update: (params: unknown) => Promise<unknown>;
  listBranches: () => Promise<unknown>;
};

type ProjectAPI = {
  getCurrent: () => Promise<unknown>;
  openPath: (params: unknown) => Promise<unknown>;
  openDialog: (params?: unknown) => Promise<unknown>;
};

type TerminalAPI = {
  ensureSession: (params: unknown) => Promise<unknown>;
  write: (sessionId: string, data: string) => void;
  resize: (sessionId: string, cols: number, rows: number) => Promise<unknown>;
  dispose: (sessionId: string, options?: unknown) => Promise<unknown>;
  listForWorkspace: (workspacePath: string) => Promise<unknown>;
  getWorkspaceState: (workspacePath: string) => Promise<unknown>;
  listSavedWorkspaces: () => Promise<unknown>;
  markQuickCommand: (workspacePath: string, slot: string) => Promise<unknown>;
  setActiveTerminal: (workspacePath: string, slot: string | null) => Promise<unknown>;
  clearWorkspaceState: (workspacePath: string) => Promise<unknown>;
  onData: (callback: (payload: unknown) => void) => ListenerDisposer;
  onExit: (callback: (payload: unknown) => void) => ListenerDisposer;
};

type JiraAPI = {
  listTickets: (params?: unknown) => Promise<unknown>;
  searchTickets: (params: unknown) => Promise<unknown>;
};

const invoke = (channel: string, payload?: unknown) => ipcRenderer.invoke(channel, payload);
const addListener = (channel: string, callback: (payload: unknown) => void): ListenerDisposer => {
  const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
};

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
} satisfies ProjectAPI);

contextBridge.exposeInMainWorld("terminalAPI", {
  ensureSession: (params) => invoke("terminal:ensure", params),
  write: (sessionId, data) => ipcRenderer.send("terminal:write", { sessionId, data }),
  resize: (sessionId, cols, rows) => invoke("terminal:resize", { sessionId, cols, rows }),
  dispose: (sessionId, options) => invoke("terminal:dispose", { sessionId, options }),
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

declare global {
  interface Window {
    workspaceAPI: WorkspaceAPI;
    projectAPI: ProjectAPI;
    terminalAPI: TerminalAPI;
    jiraAPI: JiraAPI;
  }
}
