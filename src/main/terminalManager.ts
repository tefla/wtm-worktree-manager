import { webContents } from "electron";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { terminalSessionStore, TerminalState, WorkspaceTerminalState } from "./terminalSessionStore";

// eslint-disable-next-line @typescript-eslint/no-var-requires
let pty: typeof import("node-pty") | undefined;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  pty = require("node-pty");
} catch (error) {
  console.error("Failed to load node-pty. Terminal features will be disabled until rebuilt.", error);
}

function resolveCommand(command: string): string {
  if (process.platform === "win32") {
    if (command.endsWith(".cmd") || command.endsWith(".exe")) {
      return command;
    }
    return `${command}.cmd`;
  }
  return command;
}

function defaultShellArgs(commandPath: string): string[] {
  const base = path.basename(commandPath);
  if (!base) return ["-i"];
  if (base.includes("fish")) return ["-i"];
  if (base.includes("powershell") || base.includes("pwsh")) {
    return ["-NoLogo"];
  }
  return ["-i"];
}

export interface TerminalSession {
  id: string;
  workspacePath: string;
  slot: string;
  command: string;
  args: string[];
  pty: import("node-pty").IPty;
  webContentsId: number;
  quickCommandExecuted: boolean;
  closed: boolean;
}

export interface EnsureSessionParams {
  workspacePath: string;
  slot: string;
  command?: string;
  args?: string[];
  cols?: number;
  rows?: number;
  env?: NodeJS.ProcessEnv;
  label?: string;
}

export interface EnsureSessionResult {
  sessionId: string;
  workspacePath: string;
  slot: string;
  command: string;
  args?: string[];
  existing: boolean;
  history: string;
  quickCommandExecuted: boolean;
  lastExitCode: number | null;
  lastSignal: string | null;
}

class TerminalManager {
  private sessions: Map<string, TerminalSession>;
  private workspaceIndex: Map<string, Map<string, string>>;

  constructor() {
    this.sessions = new Map();
    this.workspaceIndex = new Map();
  }

  async ensureSession(params: EnsureSessionParams, webContentsId: number): Promise<EnsureSessionResult> {
    const { workspacePath, slot, command, args, cols = 80, rows = 24, env = {}, label } = params;

    if (!workspacePath || !slot) {
      throw new Error("workspacePath and slot are required to create a terminal session.");
    }

    const absPath = path.resolve(workspacePath);
    const shellCommand = command ?? process.env.SHELL ?? "zsh";
    const shellArgs = Array.isArray(args) ? args : null;

    const savedWorkspace = await terminalSessionStore.getWorkspaceState(absPath);
    const savedTerminal = savedWorkspace.terminals?.[slot] ?? null;

    const slotIndex = this.workspaceIndex.get(absPath);
    if (slotIndex?.has(slot)) {
      const existingId = slotIndex.get(slot);
      const existingSession = existingId ? this.sessions.get(existingId) : undefined;
      if (existingSession && !existingSession.closed) {
        existingSession.webContentsId = webContentsId;
        return {
          sessionId: existingSession.id,
          workspacePath: absPath,
          slot,
          command: existingSession.command,
          args: existingSession.args,
          existing: true,
          history: savedTerminal?.history ?? "",
          quickCommandExecuted: Boolean(savedTerminal?.quickCommandExecuted),
          lastExitCode: savedTerminal?.lastExitCode ?? null,
          lastSignal: savedTerminal?.lastSignal ?? null,
        };
      }
    }

    const result = this.createSession(
      {
        workspacePath: absPath,
        slot,
        command: shellCommand,
        args: shellArgs ?? undefined,
        cols,
        rows,
        env,
      },
      webContentsId,
    );

    await terminalSessionStore.ensureTerminal(absPath, slot, { label });

    const session = this.sessions.get(result.sessionId);
    if (session && savedTerminal) {
      session.quickCommandExecuted = Boolean(savedTerminal.quickCommandExecuted);
    }

    return {
      ...result,
      history: savedTerminal?.history ?? "",
      quickCommandExecuted: Boolean(savedTerminal?.quickCommandExecuted),
      lastExitCode: savedTerminal?.lastExitCode ?? null,
      lastSignal: savedTerminal?.lastSignal ?? null,
    };
  }

  private createSession(
    params: {
      workspacePath: string;
      slot: string;
      command: string;
      args?: string[];
      cols: number;
      rows: number;
      env?: NodeJS.ProcessEnv;
    },
    webContentsId: number,
  ) {
    const { workspacePath, slot, command, args, cols, rows, env } = params;
    if (!pty) {
      throw new Error(
        "Terminal support is unavailable. Rebuild native modules with `npm rebuild node-pty --runtime=electron --target=30.0.0`.",
      );
    }
    const effectiveCommand = command ?? process.env.SHELL ?? "zsh";
    const resolvedCommand = resolveCommand(effectiveCommand);
    const resolvedArgs = Array.isArray(args) && args.length > 0 ? args : defaultShellArgs(resolvedCommand);
    const sessionId = randomUUID();

    const ptyProcess = pty.spawn(resolvedCommand, resolvedArgs, {
      name: "xterm-color",
      cols,
      rows,
      cwd: workspacePath,
      env: {
        ...process.env,
        ...env,
      },
    });

    const session: TerminalSession = {
      id: sessionId,
      workspacePath,
      slot,
      command: resolvedCommand,
      args: resolvedArgs,
      pty: ptyProcess,
      webContentsId,
      quickCommandExecuted: false,
      closed: false,
    };

    this.sessions.set(sessionId, session);
    if (!this.workspaceIndex.has(workspacePath)) {
      this.workspaceIndex.set(workspacePath, new Map());
    }
    this.workspaceIndex.get(workspacePath)?.set(slot, sessionId);

    ptyProcess.onData((data: string) => {
      this.emitData(sessionId, data);
    });

    ptyProcess.onExit((event) => {
      this.handleExit(sessionId, event);
    });

    return {
      sessionId,
      workspacePath,
      slot,
      command: resolvedCommand,
      args,
      existing: false,
    };
  }

  private emitData(sessionId: string, data: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const contents = webContents.fromId(session.webContentsId);
    if (!contents || contents.isDestroyed()) {
      return;
    }

    contents.send("terminal:data", {
      sessionId,
      data,
    });

    void terminalSessionStore.appendHistory(session.workspacePath, session.slot, data);
  }

  private async handleExit(sessionId: string, event: { exitCode?: number | null; signal?: number | string | null }) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.closed = true;
    const contents = webContents.fromId(session.webContentsId);
    if (contents && !contents.isDestroyed()) {
      contents.send("terminal:exit", {
        sessionId,
        exitCode: event?.exitCode ?? null,
        signal: (typeof event?.signal === "string" || typeof event?.signal === "number")
          ? String(event.signal)
          : null,
      });
    }

    await terminalSessionStore.markExit(session.workspacePath, session.slot, event?.exitCode ?? null, event?.signal as string);
    this.dispose(sessionId, { skipPersist: true }).catch((error) => {
      console.error("Failed to dispose terminal session", error);
    });
  }

  async dispose(sessionId: string, options: { skipPersist?: boolean } = {}): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this.sessions.delete(sessionId);
    const workspaceIndex = this.workspaceIndex.get(session.workspacePath);
    workspaceIndex?.delete(session.slot);

    if (session.pty) {
      try {
        session.pty.kill();
      } catch (error) {
        console.error("Failed to kill terminal", error);
      }
    }

    if (!options.skipPersist) {
      await terminalSessionStore.clearTerminal(session.workspacePath, session.slot);
    }
  }

  async resize(sessionId: string, cols: number, rows: number): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.pty.resize(cols, rows);
  }

  async write(sessionId: string, data: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.pty.write(data);
  }

  async listSessionsForWorkspace(workspacePath: string): Promise<Record<string, TerminalState>> {
    return terminalSessionStore.listSessionsForWorkspace(workspacePath);
  }

  async getWorkspaceState(workspacePath: string): Promise<WorkspaceTerminalState> {
    return terminalSessionStore.getWorkspaceState(workspacePath);
  }

  async listSavedWorkspaces(): Promise<string[]> {
    return terminalSessionStore.listWorkspaces();
  }

  async markQuickCommandExecuted(workspacePath: string, slot: string): Promise<void> {
    await terminalSessionStore.markQuickCommandExecuted(workspacePath, slot);
  }

  async setActiveTerminal(workspacePath: string, slot: string | null): Promise<void> {
    await terminalSessionStore.setActiveTerminalSlot(workspacePath, slot);
  }

  async clearWorkspaceState(workspacePath: string): Promise<void> {
    await terminalSessionStore.clearWorkspaceState(workspacePath);
  }
}

export const terminalManager = new TerminalManager();
