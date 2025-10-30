import { app, BrowserWindow, dialog, ipcMain, nativeImage } from "electron";
import { readFileSync } from "node:fs";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import path from "node:path";
import { WorkspaceManager } from "./workspaceManager";
import { TerminalSessionStore } from "./terminalSessionStore";
import { TerminalManager } from "./terminalManager";
import { ProjectManager } from "./projectManager";
import { TerminalHostClient } from "./terminalHostClient";
import { jiraTicketCache } from "./jiraTicketCache";
import { DockerComposeInspector } from "./dockerComposeInspector";
import type { ProjectConfig } from "./projectConfig";
import { registerWorkspaceHandlers } from "./ipc/workspaceHandlers";
import { registerTerminalHandlers } from "./ipc/terminalHandlers";
import { registerProjectHandlers } from "./ipc/projectHandlers";
import { WorkspaceService } from "./services/workspaceService";
import { TerminalService } from "./services/terminalService";
import { ProjectService } from "./services/projectService";

const isMac = process.platform === "darwin";
const iconPath = path.join(__dirname, "../assets/app-icon.svg");
function loadAppIcon(): Electron.NativeImage | undefined {
  try {
    const svgContent = readFileSync(iconPath, "utf8");
    const base64 = Buffer.from(svgContent).toString("base64");
    const dataUrl = `data:image/svg+xml;base64,${base64}`;
    const image = nativeImage.createFromDataURL(dataUrl);
    if (!image.isEmpty()) {
      return image;
    }
  } catch (error) {
    console.warn("Failed to load SVG app icon, falling back to default Electron icon.", error);
  }
  const fallback = nativeImage.createFromPath(iconPath);
  return fallback.isEmpty() ? undefined : fallback;
}
const appIcon = loadAppIcon();

interface WindowContext {
  workspaceManager: WorkspaceManager;
  workspaceService: WorkspaceService;
  terminalSessionStore: TerminalSessionStore;
  terminalHostClient: TerminalHostClient;
  terminalManager: TerminalManager;
  terminalService: TerminalService;
  projectManager: ProjectManager;
  projectService: ProjectService;
  dockerComposeInspector: DockerComposeInspector;
}

const windowContexts = new Map<number, WindowContext>();

function createWindowContext(target: BrowserWindow): WindowContext {
  const workspaceManager = new WorkspaceManager();
  const workspaceService = new WorkspaceService(workspaceManager);
  const terminalSessionStore = new TerminalSessionStore();
  const terminalHostClient = new TerminalHostClient();
  const terminalManager = new TerminalManager(terminalSessionStore, terminalHostClient);
  const terminalService = new TerminalService(terminalManager);
  const dockerComposeInspector = new DockerComposeInspector();
  const projectManager = new ProjectManager(workspaceManager, terminalSessionStore, dockerComposeInspector);
  const projectService = new ProjectService(projectManager);
  const context: WindowContext = {
    workspaceManager,
    workspaceService,
    terminalSessionStore,
    terminalHostClient,
    terminalManager,
    terminalService,
    projectManager,
    projectService,
    dockerComposeInspector,
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
    icon: appIcon,
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

function exposeJiraHandlers() {
  ipcMain.handle("jira:listTickets", async (_event, params) => {
    const forceRefresh = Boolean(params?.forceRefresh);
    return jiraTicketCache.listTickets({ forceRefresh });
  });

  ipcMain.handle("jira:searchTickets", async (_event, params) => {
    const query = typeof params?.query === "string" ? params.query : "";
    const limit = typeof params?.limit === "number" ? params.limit : undefined;
    const forceRefresh = Boolean(params?.forceRefresh);
    if (!query.trim()) {
      return [];
    }
    return jiraTicketCache.searchTickets(query, { limit, forceRefresh });
  });
}

app.whenReady().then(async () => {
  registerWorkspaceHandlers({
    ipcMain,
    dialog,
    getContext: (event) => {
      const context = getContext(event);
      return { workspaceService: context.workspaceService };
    },
  });
  registerTerminalHandlers({
    ipcMain,
    getContext: (event) => {
      const context = getContext(event);
      return { terminalService: context.terminalService };
    },
    findContext: (event) => {
      const context = findContext(event);
      return context ? { terminalService: context.terminalService } : undefined;
    },
  });
  registerProjectHandlers({
    ipcMain,
    dialog,
    createWindow,
    getContext: (event) => {
      const context = getContext(event);
      return { projectService: context.projectService };
    },
  });
  exposeJiraHandlers();
  await createWindow();
  if (isMac && appIcon) {
    app.dock.setIcon(appIcon);
  }

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
