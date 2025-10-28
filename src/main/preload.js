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
  dispose: (sessionId) => invoke("terminal:dispose", { sessionId }),
  listForWorkspace: (workspacePath) =>
    invoke("terminal:listForWorkspace", { workspacePath }),
  onData: (callback) => addListener("terminal:data", callback),
  onExit: (callback) => addListener("terminal:exit", callback),
});
