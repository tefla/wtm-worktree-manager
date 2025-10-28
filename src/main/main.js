const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("node:path");
const { workspaceManager } = require("./workspaceManager");
const { terminalManager } = require("./terminalManager");
const { settingsManager } = require("./settingsManager");

const isMac = process.platform === "darwin";

async function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#0f172a",
    title: "WTM (WorkTree Manager)",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  await mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));

  if (process.env.ELECTRON_START_URL) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }

  mainWindow.on("closed", () => {
    if (!isMac) {
      app.quit();
    }
  });
}

function exposeWorkspaceHandlers() {
  ipcMain.handle("workspace:list", async () => {
    return workspaceManager.listWorkspaces();
  });

  ipcMain.handle("workspace:create", async (_event, params) => {
    try {
      return await workspaceManager.createWorkspace(params || {});
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dialog.showErrorBox("Create Workspace Failed", message);
      throw error;
    }
  });

  ipcMain.handle("workspace:delete", async (_event, params) => {
    return workspaceManager.deleteWorkspace(params || {});
  });

  ipcMain.handle("workspace:refresh", async (_event, params) => {
    const targetPath = params?.path;
    if (!targetPath) {
      throw new Error("Path is required to refresh workspace");
    }
    return workspaceManager.refreshWorkspace(targetPath);
  });
}

function exposeTerminalHandlers() {
  ipcMain.handle("terminal:ensure", (event, params) => {
    return terminalManager.ensureSession(params || {}, event.sender.id);
  });

  ipcMain.on("terminal:write", (_event, params) => {
    if (!params?.sessionId || typeof params.data !== "string") return;
    terminalManager.write(params.sessionId, params.data);
  });

  ipcMain.handle("terminal:resize", (_event, params) => {
    if (!params?.sessionId || typeof params.cols !== "number" || typeof params.rows !== "number") {
      return;
    }
    terminalManager.resize(params.sessionId, params.cols, params.rows);
  });

  ipcMain.handle("terminal:dispose", (_event, params) => {
    if (!params?.sessionId) return;
    terminalManager.dispose(params.sessionId);
  });

  ipcMain.handle("terminal:listForWorkspace", (_event, params) => {
    if (!params?.workspacePath) return [];
    return terminalManager.listSessionsForWorkspace(params.workspacePath);
  });
}

app.whenReady().then(async () => {
  try {
    const settings = await settingsManager.load();
    workspaceManager.configure(settings);
  } catch (error) {
    dialog.showErrorBox(
      "WTM Settings Error",
      error instanceof Error ? error.message : String(error),
    );
  }

  exposeWorkspaceHandlers();
  exposeTerminalHandlers();
  await createWindow();

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (!isMac) {
    app.quit();
  }
});
