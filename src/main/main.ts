import { app, BrowserWindow, dialog, ipcMain, nativeImage } from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent, NativeImage } from "electron";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
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
import { AgentService } from "./services/agentService";
import { registerAgentHandlers } from "./ipc/agentHandlers";
import type { ProjectState } from "../shared/ipc";

const isMac = process.platform === "darwin";
const iconPath = path.join(__dirname, "../assets/app-icon.svg");
const defaultAppIcon = loadIconFromFile(iconPath);
const windowIconKeys = new Map<number, string>();
const iconWarningCache = new Set<string>();

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
  agentService: AgentService;
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
  const agentService = new AgentService({
    workspaceService,
    terminalService,
  });
  applyWindowIcon(target, null);
  projectService.registerStateTransform((state) => {
    agentService.updateProjectState(state);
    agentService.updateAgentSettings(state?.agent ?? { apiKey: null });
    return state;
  });
  projectService.registerStateTransform((state) => {
    applyWindowIcon(target, state);
    return state;
  });
  void projectService.getCurrentState().catch((error) => {
    console.warn("Failed to hydrate project state during window initialisation", error);
  });
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
    agentService,
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
    icon: defaultAppIcon ?? undefined,
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
    context.agentService.clearSessionsForWebContents(webContentsId);
    void context.terminalSessionStore.flush().catch((error) => {
      console.error("Failed to flush terminal sessions on window close", error);
    });
    windowContexts.delete(webContentsId);
    windowIconKeys.delete(webContentsId);
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
  registerAgentHandlers({
    ipcMain,
    getContext: (event) => {
      const context = getContext(event);
      return { agentService: context.agentService };
    },
  });
  exposeJiraHandlers();
  await createWindow();
  if (isMac && defaultAppIcon) {
    app.dock.setIcon(defaultAppIcon);
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

function loadIconFromFile(filePath: string): NativeImage | undefined {
  try {
    if (!existsSync(filePath)) {
      return undefined;
    }
    const extension = path.extname(filePath).toLowerCase();
    if (extension === ".svg") {
      const svgContent = readFileSync(filePath, "utf8");
      const base64 = Buffer.from(svgContent).toString("base64");
      const dataUrl = `data:image/svg+xml;base64,${base64}`;
      const image = nativeImage.createFromDataURL(dataUrl);
      return image.isEmpty() ? undefined : image;
    }
    const image = nativeImage.createFromPath(filePath);
    return image.isEmpty() ? undefined : image;
  } catch (error) {
    console.warn(`Failed to load icon from ${filePath}`, error);
    return undefined;
  }
}

function looksLikeFilePath(value: string): boolean {
  if (!value) {
    return false;
  }
  return (
    value.startsWith("file://") ||
    value.startsWith("~") ||
    path.isAbsolute(value) ||
    value.includes("/") ||
    value.includes("\\") ||
    /\.[a-zA-Z0-9]{1,4}$/.test(value)
  );
}

function resolveIconPath(rawValue: string, projectPath: string | null): string {
  if (rawValue.startsWith("file://")) {
    try {
      return fileURLToPath(rawValue);
    } catch (error) {
      console.warn("Failed to resolve file:// project icon path", error);
    }
  }
  if (rawValue.startsWith("~")) {
    return path.join(homedir(), rawValue.slice(1));
  }
  if (path.isAbsolute(rawValue) || !projectPath) {
    return rawValue;
  }
  return path.resolve(projectPath, rawValue);
}

function pickWindowIcon(state: ProjectState | null): { image: NativeImage | undefined; key: string } {
  const iconValue = state?.projectIcon?.trim();
  if (!iconValue) {
    return { image: defaultAppIcon, key: "default" };
  }
  if (iconValue.startsWith("data:")) {
    const image = nativeImage.createFromDataURL(iconValue);
    if (!image.isEmpty()) {
      return { image, key: `data:${iconValue.slice(0, 32)}` };
    }
    console.warn("Failed to decode data URL project icon; falling back to default icon.");
    return { image: defaultAppIcon, key: "default" };
  }
  if (looksLikeFilePath(iconValue)) {
    const projectPath = state?.projectPath ?? null;
    const resolved = resolveIconPath(iconValue, projectPath);
    const image = loadIconFromFile(resolved);
    if (image) {
      return { image, key: `file:${resolved}` };
    }
    if (!iconWarningCache.has(resolved)) {
      console.warn(`Failed to load project icon from ${resolved}; falling back to default icon.`);
      iconWarningCache.add(resolved);
    }
    return { image: defaultAppIcon, key: "default" };
  }
  return { image: defaultAppIcon, key: "default" };
}

function applyWindowIcon(target: BrowserWindow, state: ProjectState | null): void {
  const { image, key } = pickWindowIcon(state);
  const previousKey = windowIconKeys.get(target.webContents.id);
  if (previousKey === key) {
    return;
  }
  if (image) {
    target.setIcon(image);
    if (isMac) {
      app.dock.setIcon(image);
    }
  }
  windowIconKeys.set(target.webContents.id, key);
}
