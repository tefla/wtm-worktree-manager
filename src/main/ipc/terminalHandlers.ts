import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from "electron";
import type { TerminalManager, EnsureSessionParams } from "../terminalManager";

interface TerminalHandlerContext {
  terminalManager: TerminalManager;
}

interface RegisterTerminalHandlersOptions {
  ipcMain: IpcMain;
  getContext: (event: IpcMainEvent | IpcMainInvokeEvent) => TerminalHandlerContext;
  findContext: (event: IpcMainEvent | IpcMainInvokeEvent) => TerminalHandlerContext | undefined;
}

export function registerTerminalHandlers(options: RegisterTerminalHandlersOptions): void {
  const { ipcMain, getContext, findContext } = options;

  ipcMain.handle("terminal:ensure", (event, params: EnsureSessionParams) => {
    const context = getContext(event);
    return context.terminalManager.ensureSession(params ?? ({} as EnsureSessionParams), event.sender.id);
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
