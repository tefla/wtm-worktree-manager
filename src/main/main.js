const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("node:path");
const { workspaceManager } = require("./workspaceManager");

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

app.whenReady().then(async () => {
  exposeWorkspaceHandlers();
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
