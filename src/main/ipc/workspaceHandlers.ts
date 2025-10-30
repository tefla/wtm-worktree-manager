import type { Dialog, IpcMain, IpcMainEvent, IpcMainInvokeEvent } from "electron";
import type { WorkspaceService } from "../services/workspaceService";
import type {
  WorkspaceCreateRequest,
  WorkspaceDeleteRequest,
  WorkspaceDeleteResponse,
  WorkspaceListBranchesResponse,
  WorkspacePathRequest,
  WorkspaceSummary,
} from "../../shared/ipc";

interface WorkspaceHandlerContext {
  workspaceService: WorkspaceService;
}

interface RegisterWorkspaceHandlersOptions {
  ipcMain: IpcMain;
  dialog: Dialog;
  getContext: (event: IpcMainEvent | IpcMainInvokeEvent) => WorkspaceHandlerContext;
}

export function registerWorkspaceHandlers(options: RegisterWorkspaceHandlersOptions): void {
  const { ipcMain, dialog, getContext } = options;

  ipcMain.handle("workspace:list", async (event): Promise<WorkspaceSummary[]> => {
    const context = getContext(event);
    return context.workspaceService.listWorkspaces();
  });

  ipcMain.handle("workspace:listBranches", async (event): Promise<WorkspaceListBranchesResponse> => {
    const context = getContext(event);
    return context.workspaceService.listBranches();
  });

  ipcMain.handle("workspace:create", async (event, params: WorkspaceCreateRequest) => {
    const context = getContext(event);
    try {
      return await context.workspaceService.createWorkspace(params ?? { branch: "" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dialog.showErrorBox("Create Workspace Failed", message);
      throw error;
    }
  });

  ipcMain.handle("workspace:delete", async (event, params: WorkspaceDeleteRequest): Promise<WorkspaceDeleteResponse> => {
    const context = getContext(event);
    return context.workspaceService.deleteWorkspace(params ?? { path: "" });
  });

  ipcMain.handle("workspace:refresh", async (event, params: WorkspacePathRequest) => {
    const context = getContext(event);
    const targetPath = params?.path;
    if (!targetPath) {
      throw new Error("Path is required to refresh workspace");
    }
    return context.workspaceService.refreshWorkspace(targetPath);
  });

  ipcMain.handle("workspace:update", async (event, params: WorkspacePathRequest) => {
    const context = getContext(event);
    const targetPath = params?.path;
    if (!targetPath) {
      throw new Error("Path is required to update workspace");
    }
    try {
      return await context.workspaceService.updateWorkspace(targetPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dialog.showErrorBox("Update Workspace Failed", message);
      throw error;
    }
  });
}
