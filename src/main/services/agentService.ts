import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Agent, Runner, tool, OpenAIProvider } from "@openai/agents";
import { z } from "zod";
import type { WorkspaceService } from "./workspaceService";
import type { TerminalService } from "./terminalService";
import type { AgentEvent } from "../../shared/agent";
import type { AgentSettings, ProjectState, WorkspaceSummary } from "../../shared/ipc";
import type { WorkspaceTerminalState } from "../terminalSessionStore";

interface AgentExecutionContext {
  webContentsId: number;
  requestId: string;
  emit: (event: AgentEvent) => void;
}

interface AgentServiceOptions {
  workspaceService: WorkspaceService;
  terminalService: TerminalService;
}

export class AgentService {
  private apiKey: string | null = null;
  private agent: Agent<AgentExecutionContext> | null = null;
  private projectState: ProjectState | null = null;

  constructor(private readonly options: AgentServiceOptions) {}

  updateAgentSettings(settings: AgentSettings | null): void {
    const nextKey = settings?.apiKey?.trim() ? settings.apiKey.trim() : null;
    if (nextKey === this.apiKey) {
      return;
    }
    this.apiKey = nextKey;
  }

  updateProjectState(state: ProjectState | null): void {
    this.projectState = state;
    this.agent = null;
  }

  clearSessionsForWebContents(_webContentsId: number): void {
    // No per-session state is retained with the Agents SDK, so nothing to clean up.
  }

  private assertApiKey(): string {
    if (!this.apiKey) {
      throw new Error("OpenAI API key is not configured. Add it in Settings to chat with the agent.");
    }
    return this.apiKey;
  }

  private buildInstructions(): string {
    const projectLines: string[] = [];
    if (this.projectState) {
      projectLines.push(`Active project: ${this.projectState.projectPath}`);
      projectLines.push(`Worktree count: ${this.projectState.quickAccess.length} quick access entries configured.`);
    } else {
      projectLines.push("No active project is currently open.");
    }
    return [
      "You are the embedded workspace assistant inside WTM (WorkTree Manager).",
      "You help developers understand worktree status and run terminal commands safely.",
      "Use the provided tools to gather information before answering questions.",
      "Respond with concise, actionable steps and call out any assumptions.",
      ...projectLines,
    ].join("\n");
  }

  private emitToolCall(context: AgentExecutionContext, callId: string, name: string, args: Record<string, unknown>): void {
    context.emit({
      type: "tool_call",
      requestId: context.requestId,
      callId,
      name,
      arguments: args,
      createdAt: Date.now(),
    });
  }

  private emitToolResult(context: AgentExecutionContext, callId: string, name: string, output: unknown): void {
    context.emit({
      type: "tool_result",
      requestId: context.requestId,
      callId,
      name,
      output,
      createdAt: Date.now(),
    });
  }

  private ensureAgent(): Agent<AgentExecutionContext> {
    if (this.agent) {
      return this.agent;
    }

    const listWorkspacesTool = tool({
      name: "list_workspaces",
      description: "List the currently tracked workspaces and their git status.",
      parameters: z.object({}),
      execute: async (_input, runContext, details) => {
        const context = runContext.context;
        const callId = details?.toolCall?.id ?? randomUUID();
        this.emitToolCall(context, callId, "list_workspaces", {});
        try {
          const workspaces = await this.listWorkspaces();
          this.emitToolResult(context, callId, "list_workspaces", workspaces);
          return JSON.stringify(workspaces, null, 2);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.emitToolResult(context, callId, "list_workspaces", { error: message });
          throw error;
        }
      },
    });

    const snapshotTool = tool({
      name: "get_workspace_snapshot",
      description:
        "Inspect saved terminals for a workspace to review recent command output. Useful to understand what already happened.",
      parameters: z.object({
        workspacePath: z.string().min(1, "workspacePath is required"),
        historyLimit: z.number().int().min(100).max(6000).optional(),
      }),
      execute: async (input, runContext, details) => {
        const context = runContext.context;
        const callId = details?.toolCall?.id ?? randomUUID();
        this.emitToolCall(context, callId, "get_workspace_snapshot", input);
        try {
          const snapshot = await this.getWorkspaceSnapshot(input.workspacePath, input.historyLimit ?? 2000);
          this.emitToolResult(context, callId, "get_workspace_snapshot", snapshot);
          return JSON.stringify(snapshot, null, 2);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.emitToolResult(context, callId, "get_workspace_snapshot", { error: message });
          throw error;
        }
      },
    });

    const runCommandTool = tool({
      name: "run_command_in_workspace",
      description:
        "Run a shell command inside a workspace by launching a dedicated terminal session. Use this for targeted tasks.",
      parameters: z.object({
        workspacePath: z.string().min(1, "workspacePath is required"),
        command: z.string().min(1, "command is required"),
        label: z.string().optional(),
      }),
      execute: async (input, runContext, details) => {
        const context = runContext.context;
        const callId = details?.toolCall?.id ?? randomUUID();
        this.emitToolCall(context, callId, "run_command_in_workspace", input);
        try {
          const result = await this.runCommandInWorkspace(
            input.workspacePath,
            input.command,
            input.label,
            context.webContentsId,
          );
          this.emitToolResult(context, callId, "run_command_in_workspace", result);
          return JSON.stringify(result, null, 2);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.emitToolResult(context, callId, "run_command_in_workspace", { error: message });
          throw error;
        }
      },
    });

    this.agent = new Agent<AgentExecutionContext>({
      name: "WTM Workspace Copilot",
      instructions: () => this.buildInstructions(),
      model: "gpt-4.1-mini",
      tools: [listWorkspacesTool, snapshotTool, runCommandTool],
    });

    return this.agent;
  }

  private async listWorkspaces(): Promise<WorkspaceSummary[]> {
    return this.options.workspaceService.listWorkspaces();
  }

  private async getWorkspaceSnapshot(workspacePath: string, historyLimit: number): Promise<WorkspaceTerminalState> {
    const state = await this.options.terminalService.getWorkspaceState(workspacePath);
    const limit = Math.min(Math.max(historyLimit, 100), 6000);
    const trimmedTerminals: WorkspaceTerminalState["terminals"] = {};
    for (const [key, terminal] of Object.entries(state.terminals ?? {})) {
      trimmedTerminals[key] = {
        ...terminal,
        history:
          typeof terminal.history === "string"
            ? terminal.history.slice(-limit)
            : "",
      };
    }
    return {
      ...state,
      terminals: trimmedTerminals,
    };
  }

  private resolveShellCommand(command: string): { command: string; args: string[] } {
    if (process.platform === "win32") {
      return {
        command: process.env.COMSPEC ?? "cmd.exe",
        args: ["/d", "/s", "/c", command],
      };
    }
    const shell = process.env.SHELL && process.env.SHELL.trim() ? process.env.SHELL.trim() : "/bin/sh";
    const shellName = shell.split("/").pop();
    if (shellName && shellName.includes("fish")) {
      return { command: shell, args: ["-c", command] };
    }
    return {
      command: shell,
      args: ["-lc", command],
    };
  }

  private async runCommandInWorkspace(
    workspacePath: string,
    command: string,
    label: string | undefined,
    webContentsId: number,
  ): Promise<{ sessionId: string; slot: string; outputPreview: string }> {
    const { command: shellCommand, args } = this.resolveShellCommand(command);
    const slot = `wtm-agent-${Date.now().toString(36)}`;
    const session = await this.options.terminalService.ensureSession(
      {
        workspacePath,
        slot,
        command: shellCommand,
        args,
        label: label?.trim() ? label.trim() : `Agent task: ${command.slice(0, 64)}`,
      },
      webContentsId,
    );
    await delay(600);
    const snapshot = await this.options.terminalService.getWorkspaceState(workspacePath);
    const history = snapshot.terminals?.[slot]?.history ?? "";
    return {
      sessionId: session.sessionId,
      slot,
      outputPreview: history.slice(-1200),
    };
  }

  private extractFinalText(output: unknown): string {
    if (typeof output === "string") {
      return output.trim();
    }
    if (output && typeof output === "object" && "text" in (output as Record<string, unknown>)) {
      const textValue = (output as Record<string, unknown>).text;
      if (typeof textValue === "string") {
        return textValue.trim();
      }
    }
    return "";
  }

  async sendMessage(
    webContentsId: number,
    input: string,
    emit: (event: AgentEvent) => void,
  ): Promise<{ requestId: string; messageId: string }> {
    if (!input.trim()) {
      throw new Error("Message cannot be empty.");
    }
    const apiKey = this.assertApiKey();
    const agent = this.ensureAgent();
    const provider = new OpenAIProvider({ apiKey });
    const runner = new Runner({
      modelProvider: provider,
      model: "gpt-4.1-mini",
    });

    const requestId = randomUUID();
    const messageId = randomUUID();

    emit({
      type: "start",
      requestId,
      messageId,
      createdAt: Date.now(),
    });

    const context: AgentExecutionContext = {
      webContentsId,
      requestId,
      emit,
    };

    try {
      const result = await runner.run(agent, input, {
        context,
        maxTurns: 6,
      });
      const text = this.extractFinalText(result.finalOutput);
      emit({
        type: "completion",
        requestId,
        messageId,
        text,
        createdAt: Date.now(),
      });
    } catch (error) {
      emit({
        type: "error",
        requestId,
        messageId,
        error: error instanceof Error ? error.message : String(error),
        createdAt: Date.now(),
      });
      throw error;
    }

    return { requestId, messageId };
  }
}
