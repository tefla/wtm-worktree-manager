import { app, BrowserWindow, ipcMain, dialog } from "electron";
import path from "node:path";
import { workspaceManager } from "./workspaceManager";
import { terminalManager } from "./terminalManager";
import { settingsManager } from "./settingsManager";

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

function exposeSettingsHandlers() {
  ipcMain.handle("settings:listEnvironments", async () => {
    await settingsManager.load();
    const environments = settingsManager.listEnvironments();
    const active = settingsManager.getActiveEnvironment();
    const quickAccess = settingsManager.getQuickAccess();
    return {
      environments,
      activeEnvironment: active.name,
      quickAccess,
    };
  });

  ipcMain.handle("settings:setActiveEnvironment", async (_event, params) => {
    const name = params?.name;
    if (typeof name !== "string" || !name) {
      throw new Error("Environment name is required");
    }

    const environment = await settingsManager.setActiveEnvironment(name);
    workspaceManager.configure(environment);
    const environments = settingsManager.listEnvironments();
    const quickAccess = settingsManager.getQuickAccess();

    return {
      activeEnvironment: environment.name,
      environment,
      environments,
      quickAccess,
    };
  });
}

app.whenReady().then(async () => {
  try {
    await settingsManager.load();
    const environment = settingsManager.getActiveEnvironment();
    workspaceManager.configure(environment);
  } catch (error) {
    dialog.showErrorBox(
      "WTM Settings Error",
      error instanceof Error ? error.message : String(error),
    );
  }

  exposeWorkspaceHandlers();
  exposeTerminalHandlers();
  exposeSettingsHandlers();
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
