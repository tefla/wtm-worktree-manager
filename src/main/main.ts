import { app, BrowserWindow, ipcMain, dialog } from "electron";
import path from "node:path";
import { workspaceManager } from "./workspaceManager";
import { terminalManager } from "./terminalManager";
import { projectManager } from "./projectManager";

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

  ipcMain.handle("workspace:update", async (_event, params) => {
    const targetPath = params?.path;
    if (!targetPath) {
      throw new Error("Path is required to update workspace");
    }
    try {
      return await workspaceManager.updateWorkspace(targetPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dialog.showErrorBox("Update Workspace Failed", message);
      throw error;
    }
  });
}

function exposeTerminalHandlers() {
  ipcMain.handle("terminal:ensure", (event, params) => {
    return terminalManager.ensureSession(params || {}, event.sender.id);
  });

  ipcMain.on("terminal:write", (_event, params) => {
    if (!params?.sessionId || typeof params.data !== "string") return;
    void terminalManager.write(params.sessionId, params.data);
  });

  ipcMain.handle("terminal:resize", (_event, params) => {
    if (!params?.sessionId || typeof params.cols !== "number" || typeof params.rows !== "number") {
      return;
    }
    return terminalManager.resize(params.sessionId, params.cols, params.rows);
  });

  ipcMain.handle("terminal:dispose", (_event, params) => {
    if (!params?.sessionId) return;
    return terminalManager.dispose(params.sessionId, params.options || {});
  });

  ipcMain.handle("terminal:listForWorkspace", (_event, params) => {
    if (!params?.workspacePath) return [];
    return terminalManager.listSessionsForWorkspace(params.workspacePath);
  });

  ipcMain.handle("terminal:getWorkspaceState", (_event, params) => {
    if (!params?.workspacePath) return { activeTerminal: null, terminals: {} };
    return terminalManager.getWorkspaceState(params.workspacePath);
  });

  ipcMain.handle("terminal:listSavedWorkspaces", () => {
    return terminalManager.listSavedWorkspaces();
  });

  ipcMain.handle("terminal:markQuickCommand", (_event, params) => {
    if (!params?.workspacePath || !params?.slot) return;
    return terminalManager.markQuickCommandExecuted(params.workspacePath, params.slot);
  });

  ipcMain.handle("terminal:setActiveTerminal", (_event, params) => {
    if (!params?.workspacePath) return;
    return terminalManager.setActiveTerminal(params.workspacePath, params.slot ?? null);
  });

  ipcMain.handle("terminal:clearWorkspaceState", (_event, params) => {
    if (!params?.workspacePath) return;
    return terminalManager.clearWorkspaceState(params.workspacePath);
  });
}

function exposeProjectHandlers() {
  ipcMain.handle("project:getCurrent", async () => {
    return projectManager.getCurrentState();
  });

  ipcMain.handle("project:openPath", async (event, params) => {
    const targetPath = typeof params?.path === "string" ? params.path : "";
    if (!targetPath) {
      throw new Error("Project path is required");
    }
    const browserWindow = BrowserWindow.fromWebContents(event.sender);
    try {
      return await projectManager.setCurrentProjectWithPrompt(targetPath, browserWindow ?? undefined);
    } catch (error) {
      dialog.showErrorBox(
        "Open Project Failed",
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  });

  ipcMain.handle("project:openDialog", async (event) => {
    const browserWindow = BrowserWindow.fromWebContents(event.sender);
    const selection = await dialog.showOpenDialog(browserWindow ?? undefined, {
      properties: ["openDirectory"],
    });
    if (selection.canceled || selection.filePaths.length === 0) {
      return null;
    }
    const targetPath = selection.filePaths[0];
    try {
      return await projectManager.setCurrentProjectWithPrompt(targetPath, browserWindow ?? undefined);
    } catch (error) {
      dialog.showErrorBox(
        "Open Project Failed",
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  });
}

app.whenReady().then(async () => {
  exposeWorkspaceHandlers();
  exposeTerminalHandlers();
  exposeProjectHandlers();
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
