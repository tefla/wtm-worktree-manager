const { contextBridge, ipcRenderer } = require("electron");

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);
const addListener = (channel, callback) => {
  const listener = (_event, payload) => callback(payload);
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
});

contextBridge.exposeInMainWorld("settingsAPI", {
  listEnvironments: () => invoke("settings:listEnvironments"),
  setActiveEnvironment: (params) => invoke("settings:setActiveEnvironment", params),
});

contextBridge.exposeInMainWorld("terminalAPI", {
  ensureSession: (params) => invoke("terminal:ensure", params),
  write: (sessionId, data) => ipcRenderer.send("terminal:write", { sessionId, data }),
  resize: (sessionId, cols, rows) => invoke("terminal:resize", { sessionId, cols, rows }),
  dispose: (sessionId, options) => invoke("terminal:dispose", { sessionId, options }),
  listForWorkspace: (workspacePath) =>
    invoke("terminal:listForWorkspace", { workspacePath }),
  getWorkspaceState: (workspacePath) =>
    invoke("terminal:getWorkspaceState", { workspacePath }),
  listSavedWorkspaces: () => invoke("terminal:listSavedWorkspaces"),
  markQuickCommand: (workspacePath, slot) =>
    invoke("terminal:markQuickCommand", { workspacePath, slot }),
  setActiveTerminal: (workspacePath, slot) =>
    invoke("terminal:setActiveTerminal", { workspacePath, slot }),
  clearWorkspaceState: (workspacePath) =>
    invoke("terminal:clearWorkspaceState", { workspacePath }),
  onData: (callback) => addListener("terminal:data", callback),
  onExit: (callback) => addListener("terminal:exit", callback),
});
