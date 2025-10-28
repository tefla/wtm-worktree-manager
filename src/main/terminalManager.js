const { webContents } = require("electron");
const { randomUUID } = require("node:crypto");
const path = require("node:path");
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

function normalizeArgs(args) {
  if (!Array.isArray(args)) {
    return undefined;
  }

  const normalized = args
    .map((value) => {
      if (typeof value === "string") {
        return value.trim();
      }
      if (value === undefined || value === null) {
        return "";
      }
      return String(value).trim();
    })
    .filter((value) => value.length > 0);

  return normalized.length > 0 ? normalized : undefined;
}

function normalizeEnv(env) {
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    return {};
  }

  const normalized = {};
  for (const [key, value] of Object.entries(env)) {
    const name = typeof key === "string" ? key.trim() : String(key).trim();
    if (!name) continue;
    const stringValue =
      typeof value === "string"
        ? value
        : value === undefined || value === null
        ? ""
        : String(value);
    if (!stringValue) continue;
    normalized[name] = stringValue;
  }

  return normalized;
}

function resolveWorkingDirectory(workspacePath, cwd) {
  if (typeof cwd !== "string") {
    return path.resolve(workspacePath);
  }

  const trimmed = cwd.trim();
  if (!trimmed) {
    return path.resolve(workspacePath);
  }

  if (path.isAbsolute(trimmed)) {
    return path.resolve(trimmed);
  }

  return path.resolve(path.join(workspacePath, trimmed));
}

class TerminalManager {
  constructor() {
    this.sessions = new Map(); // sessionId -> session
    this.workspaceIndex = new Map(); // workspacePath -> Map(slot -> sessionId)
  }

  ensureSession(params, webContentsId) {
    const {
      workspacePath,
      slot,
      command,
      args,
      cols = 80,
      rows = 24,
      env = {},
      cwd,
    } = params;

    if (!workspacePath || !slot) {
      throw new Error("workspacePath and slot are required to create a terminal session.");
    }

    const absPath = path.resolve(workspacePath);
    const requestedCommand = typeof command === "string" ? command.trim() : "";
    const shellCommand = requestedCommand || process.env.SHELL || "zsh";
    const shellArgs = normalizeArgs(args);
    const normalizedEnv = normalizeEnv(env);
    const workingDirectory = resolveWorkingDirectory(absPath, cwd);

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
          env: existingSession.env,
          cwd: existingSession.cwd,
          existing: true,
        };
      }
    }

    return this.createSession(
      {
        workspacePath: absPath,
        slot,
        command: shellCommand,
        args: shellArgs,
        cols,
        rows,
        env: normalizedEnv,
        cwd: workingDirectory,
      },
      webContentsId,
    );
  }

  createSession(params, webContentsId) {
    const { workspacePath, slot, command, args, cols, rows, env, cwd } = params;
    if (!pty) {
      throw new Error(
        "Terminal support is unavailable. Rebuild native modules with `npm rebuild node-pty --runtime=electron --target=30.0.0`.",
      );
    }
    const effectiveCommand = command ?? process.env.SHELL ?? "zsh";
    const resolvedCommand = resolveCommand(effectiveCommand);
    const resolvedArgs = Array.isArray(args) && args.length > 0 ? args : defaultShellArgs(resolvedCommand);
    const workingDirectory = cwd ? path.resolve(cwd) : workspacePath;
    const sessionId = randomUUID();

    const ptyProcess = pty.spawn(resolvedCommand, resolvedArgs, {
      name: "xterm-color",
      cols,
      rows,
      cwd: workingDirectory,
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
      closed: false,
      env,
      cwd: workingDirectory,
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
      args: resolvedArgs,
      env,
      cwd: workingDirectory,
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

  dispose(sessionId) {
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
        env: session.env,
        cwd: session.cwd,
        closed: session.closed,
      }));
  }
}

module.exports = {
  terminalManager: new TerminalManager(),
};
