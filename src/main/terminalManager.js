const { webContents } = require("electron");
const { randomUUID } = require("node:crypto");
const path = require("node:path");
const { terminalSessionStore } = require("./terminalSessionStore");
let pty;
try {
  // eslint-disable-next-line global-require, import/no-extraneous-dependencies
  pty = require("node-pty");
} catch (error) {
  console.error("Failed to load node-pty. Terminal features will be disabled until rebuilt.", error);
}

function resolveCommand(command) {
  if (process.platform === "win32") {
    if (command.endsWith(".cmd") || command.endsWith(".exe")) {
      return command;
    }
    return `${command}.cmd`;
  }
  return command;
}

function defaultShellArgs(commandPath) {
  const base = path.basename(commandPath);
  if (!base) return ["-i"];
  if (base.includes("fish")) return ["-i"];
  if (base.includes("powershell") || base.includes("pwsh")) {
    return ["-NoLogo"];
  }
  return ["-i"];
}

class TerminalManager {
  constructor() {
    this.sessions = new Map(); // sessionId -> session
    this.workspaceIndex = new Map(); // workspacePath -> Map(slot -> sessionId)
  }

  async ensureSession(params, webContentsId) {
    const {
      workspacePath,
      slot,
      command,
      args,
      cols = 80,
      rows = 24,
      env = {},
    } = params;

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

    await terminalSessionStore.ensureTerminal(absPath, slot);

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

  createSession(params, webContentsId) {
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

    const session = {
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
    this.workspaceIndex.get(workspacePath).set(slot, sessionId);

    ptyProcess.onData((data) => {
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

  emitData(sessionId, data) {
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

  handleExit(sessionId, event) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.closed = true;
    const contents = webContents.fromId(session.webContentsId);
    if (contents && !contents.isDestroyed()) {
      contents.send("terminal:exit", {
        sessionId,
        exitCode: event?.exitCode ?? null,
        signal: event?.signal ?? null,
      });
    }

    void terminalSessionStore.markExit(
      session.workspacePath,
      session.slot,
      event?.exitCode ?? null,
      event?.signal ?? null,
    );
  }

  write(sessionId, data) {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) return;
    session.pty.write(data);
  }

  resize(sessionId, cols, rows) {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) return;
    session.pty.resize(cols, rows);
  }

  async dispose(sessionId, options = {}) {
    const preserve = Boolean(options.preserve);
    const session = this.sessions.get(sessionId);
    if (!session) return;

    try {
      session.pty.kill();
    } catch (error) {
      console.warn(`Failed to kill terminal session ${sessionId}`, error);
    }

    session.closed = true;
    this.sessions.delete(sessionId);

    const slotIndex = this.workspaceIndex.get(session.workspacePath);
    if (slotIndex?.get(session.slot) === sessionId) {
      slotIndex.delete(session.slot);
    }
    if (slotIndex && slotIndex.size === 0) {
      this.workspaceIndex.delete(session.workspacePath);
    }

    if (!preserve) {
      await terminalSessionStore.clearTerminal(session.workspacePath, session.slot);
    }
  }

  listSessionsForWorkspace(workspacePath) {
    const absPath = path.resolve(workspacePath);
    const slotIndex = this.workspaceIndex.get(absPath);
    if (!slotIndex) return [];
    return Array.from(slotIndex.values())
      .map((sessionId) => this.sessions.get(sessionId))
      .filter(Boolean)
      .map((session) => ({
        sessionId: session.id,
        workspacePath: session.workspacePath,
        slot: session.slot,
        command: session.command,
        args: session.args,
        closed: session.closed,
      }));
  }

  lookupSession(workspacePath, slot) {
    const absPath = path.resolve(workspacePath);
    const slotIndex = this.workspaceIndex.get(absPath);
    if (!slotIndex) return null;
    const sessionId = slotIndex.get(slot);
    if (!sessionId) return null;
    return this.sessions.get(sessionId) ?? null;
  }

  async markQuickCommandExecuted(workspacePath, slot) {
    await terminalSessionStore.markQuickCommand(workspacePath, slot);
    const session = this.lookupSession(workspacePath, slot);
    if (session) {
      session.quickCommandExecuted = true;
    }
  }

  async setActiveTerminal(workspacePath, slot) {
    await terminalSessionStore.setActiveTerminal(workspacePath, slot ?? null);
  }

  async getWorkspaceState(workspacePath) {
    return terminalSessionStore.getWorkspaceState(workspacePath);
  }

  async listSavedWorkspaces() {
    return terminalSessionStore.listWorkspaces();
  }

  async clearWorkspaceState(workspacePath) {
    await terminalSessionStore.clearWorkspace(workspacePath);
  }
}

module.exports = {
  terminalManager: new TerminalManager(),
};
