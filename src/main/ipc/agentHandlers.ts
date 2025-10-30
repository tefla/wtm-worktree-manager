import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { AgentService } from "../services/agentService";
import type { AgentRequest } from "../../shared/agent";

interface RegisterAgentHandlersOptions {
  ipcMain: IpcMain;
  getContext: (event: IpcMainInvokeEvent) => { agentService: AgentService };
}

export function registerAgentHandlers(options: RegisterAgentHandlersOptions): void {
  const { ipcMain, getContext } = options;

  ipcMain.handle("agent:sendMessage", async (event, payload: AgentRequest) => {
    const { agentService } = getContext(event);
    const message = typeof payload?.message === "string" ? payload.message : "";
    return agentService.sendMessage(event.sender.id, message, (agentEvent) => {
      event.sender.send("agent:event", agentEvent);
    });
  });

  ipcMain.handle("agent:resetSession", async (event) => {
    const { agentService } = getContext(event);
    agentService.clearSessionsForWebContents(event.sender.id);
    return { success: true };
  });
}
