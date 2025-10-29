import { app, BrowserWindow, dialog, ipcMain } from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import path from "node:path";
import { WorkspaceManager } from "./workspaceManager";
import { TerminalSessionStore } from "./terminalSessionStore";
import { TerminalManager } from "./terminalManager";
import { ProjectManager } from "./projectManager";
import { TerminalHostClient } from "./terminalHostClient";

const isMac = process.platform === "darwin";

interface WindowContext {
  workspaceManager: WorkspaceManager;
  terminalSessionStore: TerminalSessionStore;
  terminalHostClient: TerminalHostClient;
  terminalManager: TerminalManager;
  projectManager: ProjectManager;
}

const windowContexts = new Map<number, WindowContext>();

function createWindowContext(target: BrowserWindow): WindowContext {
  const workspaceManager = new WorkspaceManager();
  const terminalSessionStore = new TerminalSessionStore();
  const terminalHostClient = new TerminalHostClient();
  const terminalManager = new TerminalManager(terminalSessionStore, terminalHostClient);
  const projectManager = new ProjectManager(workspaceManager, terminalSessionStore);
  const context: WindowContext = {
    workspaceManager,
    terminalSessionStore,
    terminalHostClient,
    terminalManager,
    projectManager,
  };
  windowContexts.set(target.webContents.id, context);
  return context;
}

function getContext(event: IpcMainEvent | IpcMainInvokeEvent): WindowContext {
  const context = windowContexts.get(event.sender.id);
  if (!context) {
    throw new Error("Window context not available for request");
  }
  return context;
}

function findContext(event: IpcMainEvent | IpcMainInvokeEvent): WindowContext | undefined {
  return windowContexts.get(event.sender.id);
}

async function createWindow(): Promise<BrowserWindow> {
  const window = new BrowserWindow({
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

  const context = createWindowContext(window);
  const webContentsId = window.webContents.id;

  window.on("closed", () => {
    void context.terminalManager.disposeSessionsForWebContents(webContentsId);
    void context.terminalSessionStore.flush().catch((error) => {
      console.error("Failed to flush terminal sessions on window close", error);
    });
    windowContexts.delete(webContentsId);
  });

  await window.loadFile(path.join(__dirname, "../renderer/index.html"));

  if (process.env.ELECTRON_START_URL) {
    window.webContents.openDevTools({ mode: "detach" });
  }

  return window;
}

function exposeWorkspaceHandlers() {
  ipcMain.handle("workspace:list", async (event) => {
    const context = getContext(event);
    return context.workspaceManager.listWorkspaces();
  });

  ipcMain.handle("workspace:create", async (event, params) => {
    const context = getContext(event);
    try {
      return await context.workspaceManager.createWorkspace(params || {});
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dialog.showErrorBox("Create Workspace Failed", message);
      throw error;
    }
  });

  ipcMain.handle("workspace:delete", async (event, params) => {
    const context = getContext(event);
    return context.workspaceManager.deleteWorkspace(params || {});
  });

  ipcMain.handle("workspace:refresh", async (event, params) => {
    const context = getContext(event);
    const targetPath = params?.path;
    if (!targetPath) {
      throw new Error("Path is required to refresh workspace");
    }
    return context.workspaceManager.refreshWorkspace(targetPath);
  });

  ipcMain.handle("workspace:update", async (event, params) => {
    const context = getContext(event);
    const targetPath = params?.path;
    if (!targetPath) {
      throw new Error("Path is required to update workspace");
    }
    try {
      return await context.workspaceManager.updateWorkspace(targetPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dialog.showErrorBox("Update Workspace Failed", message);
      throw error;
    }
  });
}

function exposeTerminalHandlers() {
  ipcMain.handle("terminal:ensure", (event, params) => {
    const context = getContext(event);
    return context.terminalManager.ensureSession(params || {}, event.sender.id);
  });

  ipcMain.on("terminal:write", (event, params) => {
    if (!params?.sessionId || typeof params.data !== "string") return;
    const context = findContext(event);
    if (!context) return;
    void context.terminalManager.write(params.sessionId, params.data);
  });

  ipcMain.handle("terminal:resize", (event, params) => {
    if (!params?.sessionId || typeof params.cols !== "number" || typeof params.rows !== "number") {
      return;
    }
    const context = getContext(event);
    return context.terminalManager.resize(params.sessionId, params.cols, params.rows);
  });

  ipcMain.handle("terminal:dispose", (event, params) => {
    if (!params?.sessionId) return;
    const context = getContext(event);
    return context.terminalManager.dispose(params.sessionId, params.options || {});
  });

  ipcMain.handle("terminal:release", (event, params) => {
    if (!params?.sessionId) return;
    const context = getContext(event);
    return context.terminalManager.release(params.sessionId, event.sender.id);
  });

  ipcMain.handle("terminal:listForWorkspace", (event, params) => {
    if (!params?.workspacePath) return [];
    const context = getContext(event);
    return context.terminalManager.listSessionsForWorkspace(params.workspacePath);
  });

  ipcMain.handle("terminal:getWorkspaceState", (event, params) => {
    if (!params?.workspacePath) return { activeTerminal: null, terminals: {} };
    const context = getContext(event);
    return context.terminalManager.getWorkspaceState(params.workspacePath);
  });

  ipcMain.handle("terminal:listSavedWorkspaces", (event) => {
    const context = getContext(event);
    return context.terminalManager.listSavedWorkspaces();
  });

  ipcMain.handle("terminal:markQuickCommand", (event, params) => {
    if (!params?.workspacePath || !params?.slot) return;
    const context = getContext(event);
    return context.terminalManager.markQuickCommandExecuted(params.workspacePath, params.slot);
  });

  ipcMain.handle("terminal:setActiveTerminal", (event, params) => {
    if (!params?.workspacePath) return;
    const context = getContext(event);
    return context.terminalManager.setActiveTerminal(params.workspacePath, params.slot ?? null);
  });

  ipcMain.handle("terminal:clearWorkspaceState", (event, params) => {
    if (!params?.workspacePath) return;
    const context = getContext(event);
    return context.terminalManager.clearWorkspaceState(params.workspacePath);
  });
}

function exposeProjectHandlers() {
  ipcMain.handle("project:getCurrent", async (event) => {
    const context = getContext(event);
    return context.projectManager.getCurrentState();
  });

  ipcMain.handle("project:openPath", async (event, params) => {
    const targetPath = typeof params?.path === "string" ? params.path : "";
    const openInNewWindow = Boolean(params?.openInNewWindow);
    if (!targetPath) {
      throw new Error("Project path is required");
    }

    if (openInNewWindow) {
      try {
        const newWindow = await createWindow();
        const newContext = windowContexts.get(newWindow.webContents.id);
        if (!newContext) {
          newWindow.close();
          throw new Error("Failed to initialise window context");
        }
        try {
          return await newContext.projectManager.setCurrentProjectWithPrompt(targetPath, newWindow);
        } catch (error) {
          newWindow.close();
          throw error;
        }
      } catch (error) {
        dialog.showErrorBox(
          "Open Project Failed",
          error instanceof Error ? error.message : String(error),
        );
        throw error;
      }
    }

    const context = getContext(event);
    const browserWindow = BrowserWindow.fromWebContents(event.sender);
    try {
      return await context.projectManager.setCurrentProjectWithPrompt(targetPath, browserWindow ?? undefined);
    } catch (error) {
      dialog.showErrorBox(
        "Open Project Failed",
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  });

  ipcMain.handle("project:openDialog", async (event, params) => {
    const openInNewWindow = Boolean(params?.openInNewWindow);
    const browserWindow = BrowserWindow.fromWebContents(event.sender);
    const selection = await dialog.showOpenDialog(browserWindow ?? undefined, {
      properties: ["openDirectory"],
    });
    if (selection.canceled || selection.filePaths.length === 0) {
      return null;
    }
    const targetPath = selection.filePaths[0];

    if (openInNewWindow) {
      try {
        const newWindow = await createWindow();
        const newContext = windowContexts.get(newWindow.webContents.id);
        if (!newContext) {
          newWindow.close();
          throw new Error("Failed to initialise window context");
        }
        try {
          return await newContext.projectManager.setCurrentProjectWithPrompt(targetPath, newWindow);
        } catch (error) {
          newWindow.close();
          throw error;
        }
      } catch (error) {
        dialog.showErrorBox(
          "Open Project Failed",
          error instanceof Error ? error.message : String(error),
        );
        throw error;
      }
    }

    const context = getContext(event);
    try {
      return await context.projectManager.setCurrentProjectWithPrompt(targetPath, browserWindow ?? undefined);
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
