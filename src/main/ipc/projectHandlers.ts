import { BrowserWindow } from "electron";
import type { Dialog, IpcMain, IpcMainEvent, IpcMainInvokeEvent } from "electron";
import type { ProjectService } from "../services/projectService";
import type { ProjectState, ProjectOpenPathRequest, ProjectOpenDialogRequest, ProjectUpdateConfigRequest } from "../../shared/ipc";
import type { ProjectManager } from "../projectManager";
import type { ProjectConfig } from "../projectConfig";

interface ProjectHandlerContext {
  projectService: ProjectService;
}

interface RegisterProjectHandlersOptions {
  ipcMain: IpcMain;
  dialog: Dialog;
  createWindow: () => Promise<BrowserWindow>;
  getContext: (event: IpcMainEvent | IpcMainInvokeEvent) => ProjectHandlerContext;
}

export function registerProjectHandlers(options: RegisterProjectHandlersOptions): void {
  const { ipcMain, dialog, getContext, createWindow } = options;

  ipcMain.handle("project:getCurrent", async (event) => {
    const context = getContext(event);
    return context.projectService.getCurrentState();
  });

  ipcMain.handle("project:listComposeServices", async (event) => {
    const context = getContext(event);
    return context.projectService.listComposeServices();
  });

  ipcMain.handle("project:updateConfig", async (event, params: ProjectUpdateConfigRequest) => {
    const context = getContext(event);
    const config = params?.config ?? params;
    if (!config || typeof config !== "object") {
      throw new Error("Project configuration payload is required");
    }
    return context.projectService.updateConfig(config as ProjectConfig);
  });

  ipcMain.handle("project:openPath", async (event, params: ProjectOpenPathRequest) => {
    const targetPath = typeof params?.path === "string" ? params.path : "";
    const openInNewWindow = Boolean(params?.openInNewWindow);
    if (!targetPath) {
      throw new Error("Project path is required");
    }

    if (openInNewWindow) {
      try {
        const newWindow = await createWindow();
        const newContext = getContext({ sender: newWindow.webContents } as unknown as IpcMainEvent);
        try {
          return await newContext.projectService.setCurrentProjectWithPrompt(targetPath, newWindow);
        } catch (error) {
          newWindow.close();
          throw error;
        }
      } catch (error) {
        dialog.showErrorBox("Open Project Failed", error instanceof Error ? error.message : String(error));
        throw error;
      }
    }

    const context = getContext(event);
    const browserWindow = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    try {
      return await context.projectService.setCurrentProjectWithPrompt(targetPath, browserWindow);
    } catch (error) {
      dialog.showErrorBox("Open Project Failed", error instanceof Error ? error.message : String(error));
      throw error;
    }
  });

  ipcMain.handle("project:openDialog", async (event, params: ProjectOpenDialogRequest) => {
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
        const newContext = getContext({ sender: newWindow.webContents } as unknown as IpcMainEvent);
        try {
          return await newContext.projectService.setCurrentProjectWithPrompt(targetPath, newWindow);
        } catch (error) {
          newWindow.close();
          throw error;
        }
      } catch (error) {
        dialog.showErrorBox("Open Project Failed", error instanceof Error ? error.message : String(error));
        throw error;
      }
    }

    const context = getContext(event);
    try {
      return await context.projectService.setCurrentProjectWithPrompt(targetPath, browserWindow ?? undefined);
    } catch (error) {
      dialog.showErrorBox("Open Project Failed", error instanceof Error ? error.message : String(error));
      throw error;
    }
  });
}
