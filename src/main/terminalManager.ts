import { webContents } from "electron";
import path from "node:path";
import { TerminalHostClient } from "./terminalHostClient";
import { TerminalSessionStore, TerminalState, WorkspaceTerminalState } from "./terminalSessionStore";

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

interface SessionBinding {
  id: string;
  workspacePath: string;
  slot: string;
  command: string;
  args: string[];
  subscribers: Set<number>;
  quickCommandExecuted: boolean;
  lastExitCode: number | null;
  lastSignal: string | null;
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

export class TerminalManager {
  private sessions: Map<string, SessionBinding>;
  private workspaceIndex: Map<string, Map<string, string>>;

  constructor(
    private readonly store: TerminalSessionStore,
    private readonly hostClient: TerminalHostClient,
  ) {
    this.sessions = new Map();
    this.workspaceIndex = new Map();

    this.hostClient.on("session-data", (payload) => {
      void this.handleHostData(payload.sessionId, payload.data);
    });
    this.hostClient.on("session-exit", (payload) => {
      void this.handleHostExit(payload.sessionId, payload.exitCode, payload.signal);
    });
    this.hostClient.on("session-disposed", (payload) => {
      this.handleHostDisposed(payload.sessionId);
    });
  }

  async ensureSession(params: EnsureSessionParams, webContentsId: number): Promise<EnsureSessionResult> {
    const { workspacePath, slot, command, args, cols = 80, rows = 24, env = {}, label } = params;

    if (!workspacePath || !slot) {
      throw new Error("workspacePath and slot are required to create a terminal session.");
    }

    const absPath = path.resolve(workspacePath);
    const savedWorkspace = await this.store.getWorkspaceState(absPath);
    const savedTerminal = savedWorkspace.terminals?.[slot] ?? null;
    const quickCommandExecuted = Boolean(savedTerminal?.quickCommandExecuted);
    const lastExitCode = savedTerminal?.lastExitCode ?? null;
    const lastSignal = savedTerminal?.lastSignal ?? null;
    const previousHistory = savedTerminal?.history ?? "";

    const resolvedCommand = resolveCommand(command ?? process.env.SHELL ?? "zsh");
    const resolvedArgs = Array.isArray(args) && args.length > 0 ? args : defaultShellArgs(resolvedCommand);

    const hostResult = await this.hostClient.ensureSession({
      workspacePath: absPath,
      slot,
      command: resolvedCommand,
      args: resolvedArgs,
      cols,
      rows,
      env,
      label,
    });

    const sessionId = hostResult.sessionId;

    let binding = this.sessions.get(sessionId);
    if (!binding) {
      binding = {
        id: sessionId,
        workspacePath: absPath,
        slot,
        command: hostResult.command,
        args: hostResult.args ?? [],
        subscribers: new Set(),
        quickCommandExecuted,
        lastExitCode,
        lastSignal,
        closed: false,
      };
      this.sessions.set(sessionId, binding);
    }

    binding.subscribers.add(webContentsId);
    binding.closed = false;
    binding.command = hostResult.command;
    binding.args = hostResult.args ?? resolvedArgs;
    binding.quickCommandExecuted = quickCommandExecuted;
    binding.lastExitCode = lastExitCode;
    binding.lastSignal = lastSignal;

    if (!this.workspaceIndex.has(absPath)) {
      this.workspaceIndex.set(absPath, new Map());
    }
    this.workspaceIndex.get(absPath)?.set(slot, sessionId);

    await this.store.ensureTerminal(absPath, slot, { label });

    let history = previousHistory;
    const pending = hostResult.pendingOutput ?? "";
    if (pending) {
      await this.store.appendHistory(absPath, slot, pending);
      history = `${history}${pending}`;
    }

    return {
      sessionId,
      workspacePath: absPath,
      slot,
      command: binding.command,
      args: binding.args,
      existing: hostResult.existing,
      history,
      quickCommandExecuted,
      lastExitCode,
      lastSignal,
    };
  }

  async write(sessionId: string, data: string): Promise<void> {
    await this.hostClient.write({ sessionId, data });
  }

  async resize(sessionId: string, cols: number, rows: number): Promise<void> {
    await this.hostClient.resize({ sessionId, cols, rows });
  }

  async dispose(sessionId: string, options: { skipPersist?: boolean; preserve?: boolean } = {}): Promise<void> {
    const binding = this.sessions.get(sessionId);
    if (!binding) {
      await this.hostClient.dispose({ sessionId });
      return;
    }

    this.sessions.delete(sessionId);
    const workspaceIndex = this.workspaceIndex.get(binding.workspacePath);
    workspaceIndex?.delete(binding.slot);

    binding.subscribers.clear();
    await this.hostClient.dispose({ sessionId });

    const skipPersist = Boolean(options.skipPersist ?? options.preserve);
    if (!skipPersist) {
      await this.store.clearTerminal(binding.workspacePath, binding.slot);
    }
  }

  async release(sessionId: string, webContentsId: number): Promise<void> {
    const binding = this.sessions.get(sessionId);
    if (!binding) return;
    if (!binding.subscribers.has(webContentsId)) return;

    binding.subscribers.delete(webContentsId);
    if (binding.subscribers.size === 0 && !binding.closed) {
      await this.hostClient.releaseSession({ sessionId });
    }
  }

  async disposeSessionsForWebContents(webContentsId: number): Promise<void> {
    const affected: SessionBinding[] = [];
    for (const session of this.sessions.values()) {
      if (session.subscribers.has(webContentsId)) {
        session.subscribers.delete(webContentsId);
        affected.push(session);
      }
    }
    for (const session of affected) {
      if (session.subscribers.size === 0 && !session.closed) {
        await this.hostClient.releaseSession({ sessionId: session.id });
      }
    }
  }

  async listSessionsForWorkspace(workspacePath: string): Promise<Record<string, TerminalState>> {
    return this.store.listSessionsForWorkspace(workspacePath);
  }

  async getWorkspaceState(workspacePath: string): Promise<WorkspaceTerminalState> {
    return this.store.getWorkspaceState(workspacePath);
  }

  async listSavedWorkspaces(): Promise<string[]> {
    return this.store.listWorkspaces();
  }

  async markQuickCommandExecuted(workspacePath: string, slot: string): Promise<void> {
    await this.store.markQuickCommandExecuted(workspacePath, slot);
    const sessionId = this.workspaceIndex.get(path.resolve(workspacePath))?.get(slot);
    if (sessionId) {
      const binding = this.sessions.get(sessionId);
      if (binding) {
        binding.quickCommandExecuted = true;
      }
    }
  }

  async setActiveTerminal(workspacePath: string, slot: string | null): Promise<void> {
    await this.store.setActiveTerminalSlot(workspacePath, slot);
  }

  async clearWorkspaceState(workspacePath: string): Promise<void> {
    await this.store.clearWorkspaceState(workspacePath);
  }

  private async handleHostData(sessionId: string, data: string): Promise<void> {
    const binding = this.sessions.get(sessionId);
    if (!binding) return;

    await this.store.appendHistory(binding.workspacePath, binding.slot, data);

    for (const targetId of binding.subscribers) {
      const contents = webContents.fromId(targetId);
      if (!contents || contents.isDestroyed()) {
        binding.subscribers.delete(targetId);
        continue;
      }
      contents.send("terminal:data", {
        sessionId,
        data,
      });
    }
  }

  private async handleHostExit(sessionId: string, exitCode: number | null, signal: string | null): Promise<void> {
    const binding = this.sessions.get(sessionId);
    if (!binding) return;

    binding.closed = true;
    binding.lastExitCode = exitCode;
    binding.lastSignal = signal;

    await this.store.markExit(binding.workspacePath, binding.slot, exitCode, signal);

    for (const targetId of binding.subscribers) {
      const contents = webContents.fromId(targetId);
      if (!contents || contents.isDestroyed()) {
        binding.subscribers.delete(targetId);
        continue;
      }
      contents.send("terminal:exit", {
        sessionId,
        exitCode,
        signal,
      });
    }

    const workspaceIndex = this.workspaceIndex.get(binding.workspacePath);
    workspaceIndex?.delete(binding.slot);
    this.sessions.delete(sessionId);
  }

  private handleHostDisposed(sessionId: string): void {
    const binding = this.sessions.get(sessionId);
    if (!binding) return;

    binding.closed = true;
    for (const targetId of binding.subscribers) {
      const contents = webContents.fromId(targetId);
      if (!contents || contents.isDestroyed()) {
        continue;
      }
      contents.send("terminal:exit", {
        sessionId,
        exitCode: null,
        signal: null,
      });
    }
    binding.subscribers.clear();
    const workspaceIndex = this.workspaceIndex.get(binding.workspacePath);
    workspaceIndex?.delete(binding.slot);
    this.sessions.delete(sessionId);
  }
}
