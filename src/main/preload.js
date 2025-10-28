const { contextBridge, ipcRenderer } = require("electron");

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld("workspaceAPI", {
  list: () => invoke("workspace:list"),
  create: (params) => invoke("workspace:create", params),
  delete: (params) => invoke("workspace:delete", params),
  refresh: (params) => invoke("workspace:refresh", params),
});
