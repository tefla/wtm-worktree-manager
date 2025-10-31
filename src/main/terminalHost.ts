import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { rmSync } from "node:fs";
import { createServer, Server, Socket } from "node:net";
import path from "node:path";
import process from "node:process";
import type { IPty } from "node-pty";
import {
  HostConfigurePayload,
  HostDataEventPayload,
  HostDisposePayload,
  HostEnsureSessionPayload,
  HostEnsureSessionResult,
  HostExitEventPayload,
  HostListSessionsResult,
  HostReleasePayload,
  HostResizePayload,
  HostWritePayload,
  TerminalHostEventMessage,
  TerminalHostMessage,
  TerminalHostRequestMessage,
  TerminalHostResponseMessage,
} from "./terminalHostProtocol";
import { getHostSocketPath } from "./terminalHostPaths";
const useFakePty = process.env.WTM_FAKE_PTY === "1";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const realPty: typeof import("node-pty") | null = useFakePty ? null : require("node-pty");

interface PtyAdapter {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(handler: (data: string) => void): void;
  onExit(handler: (event: { exitCode?: number | null; signal?: number | string | null }) => void): void;
}

class FakePty implements PtyAdapter {
  private readonly emitter: EventEmitter;
  private killed: boolean;

  constructor() {
    this.emitter = new EventEmitter();
    this.killed = false;
  }

  write(data: string): void {
    if (this.killed) return;
    setTimeout(() => {
      this.emitter.emit("data", data);
    }, 0);
  }

  resize(): void {
    // no-op
  }

  kill(): void {
    if (this.killed) return;
    this.killed = true;
    this.emitter.emit("exit", { exitCode: 0, signal: null });
  }

  onData(handler: (data: string) => void): void {
    this.emitter.on("data", handler);
  }

  onExit(handler: (event: { exitCode?: number | null; signal?: number | string | null }) => void): void {
    this.emitter.on("exit", handler);
  }
}

interface SessionDescriptor {
  id: string;
  workspacePath: string;
  slot: string;
  command: string;
  args: string[];
  pty: PtyAdapter;
  subscribers: Set<ClientDescriptor>;
  pendingOutput: string;
  disposed: boolean;
}

interface ClientDescriptor {
  id: string;
  socket: Socket;
  buffer: string;
  closed: boolean;
  subscribedSessions: Set<string>;
}

const HISTORY_LIMIT = 40000;
const DEFAULT_IDLE_MS = 60_000;
const IDLE_SHUTDOWN_MS = process.env.WTM_IDLE_SHUTDOWN_MS
  ? Number(process.env.WTM_IDLE_SHUTDOWN_MS)
  : DEFAULT_IDLE_MS;

class TerminalHostServer {
  private server: Server | null;
  private sessions: Map<string, SessionDescriptor>;
  private sessionIndex: Map<string, string>;
  private clients: Map<string, ClientDescriptor>;
  private storePath: string | null;
  private shutdownTimer: NodeJS.Timeout | null;
  private readonly useFakePty: boolean;

  constructor(private readonly socketPath: string) {
    this.server = null;
    this.sessions = new Map();
    this.sessionIndex = new Map();
    this.clients = new Map();
    this.storePath = null;
    this.shutdownTimer = null;
    this.useFakePty = useFakePty;
  }

  start(): void {
    if (this.server) {
      return;
    }

    try {
      rmSync(this.socketPath, { force: true });
    } catch (error) {
      console.warn("Failed to cleanup stale socket", error);
    }

    this.server = createServer((socket) => this.handleConnection(socket));
    this.server.listen(this.socketPath, () => {
      this.log("info", `Terminal host listening at ${this.socketPath}`);
    });

    this.server.on("error", (error) => {
      this.log("error", `Server error: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
  }

  private log(level: "info" | "warn" | "error", message: string): void {
    const line = `[terminal-host][${level}] ${message}`;
    if (level === "error") {
      console.error(line);
    } else if (level === "warn") {
      console.warn(line);
    } else {
      console.log(line);
    }
  }

  private handleConnection(socket: Socket): void {
    const clientId = randomUUID();
    const client: ClientDescriptor = {
      id: clientId,
      socket,
      buffer: "",
      closed: false,
      subscribedSessions: new Set(),
    };
    this.clients.set(clientId, client);
    this.log("info", `Client connected ${clientId}`);
    this.evaluateIdle();

    socket.on("data", (chunk) => {
      client.buffer += chunk.toString("utf8");
      let newlineIndex: number;
      while ((newlineIndex = client.buffer.indexOf("\n")) >= 0) {
        const raw = client.buffer.slice(0, newlineIndex).trim();
        client.buffer = client.buffer.slice(newlineIndex + 1);
        if (!raw) continue;
        try {
          const message = JSON.parse(raw) as TerminalHostMessage;
          this.handleMessage(client, message);
        } catch (error) {
          this.log("warn", `Failed to parse message from client ${clientId}: ${raw}`);
        }
      }
    });

    socket.on("close", () => {
      this.log("info", `Client disconnected ${clientId}`);
      client.closed = true;
      this.cleanupClient(client);
      this.evaluateIdle();
    });

    socket.on("error", (error) => {
      this.log("warn", `Socket error for client ${clientId}: ${error instanceof Error ? error.message : String(error)}`);
      socket.destroy();
    });
  }

  private handleMessage(client: ClientDescriptor, message: TerminalHostMessage): void {
    if (message.type === "request") {
      void this.handleRequest(client, message);
    }
  }

  private async handleRequest(client: ClientDescriptor, message: TerminalHostRequestMessage): Promise<void> {
    const { command, id, payload } = message;
    try {
      switch (command) {
        case "ping":
          this.sendResponse(client, { type: "response", id, ok: true, result: { ok: true } });
          break;
        case "configure":
          this.configure(payload as HostConfigurePayload);
          this.sendResponse(client, { type: "response", id, ok: true, result: { ok: true } });
          break;
        case "ensureSession": {
          const result = await this.ensureSession(client, payload as HostEnsureSessionPayload);
          this.sendResponse(client, { type: "response", id, ok: true, result });
          break;
        }
        case "releaseSession": {
          this.releaseSession(client, payload as HostReleasePayload);
          this.sendResponse(client, { type: "response", id, ok: true });
          break;
        }
        case "writeSession": {
          this.writeSession(payload as HostWritePayload);
          this.sendResponse(client, { type: "response", id, ok: true });
          break;
        }
        case "resizeSession": {
          this.resizeSession(payload as HostResizePayload);
          this.sendResponse(client, { type: "response", id, ok: true });
          break;
        }
        case "disposeSession": {
          await this.disposeSession(payload as HostDisposePayload);
          this.sendResponse(client, { type: "response", id, ok: true });
          break;
        }
        case "listSessions": {
          const result = this.listSessions();
          this.sendResponse(client, { type: "response", id, ok: true, result });
          break;
        }
        case "getWorkspaceState": {
          const workspacePath = (payload as { workspacePath?: string })?.workspacePath;
          const result = this.getWorkspaceState(workspacePath);
          this.sendResponse(client, { type: "response", id, ok: true, result });
          break;
        }
        default:
          throw new Error(`Unsupported command: ${command}`);
      }
    } catch (error) {
      this.sendResponse(client, {
        type: "response",
        id,
        ok: false,
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private configure(payload?: HostConfigurePayload): void {
    if (payload?.storePath) {
      this.storePath = payload.storePath;
      this.log("info", `Configured store path ${this.storePath}`);
    }
  }

  private async ensureSession(client: ClientDescriptor, payload: HostEnsureSessionPayload): Promise<HostEnsureSessionResult> {
    return await this.ensureSessionWithPty(client, payload);
  }

  private async ensureSessionWithPty(
    client: ClientDescriptor,
    payload: HostEnsureSessionPayload,
  ): Promise<HostEnsureSessionResult> {
    const { workspacePath, slot, command, args = [], cols, rows, env = {} } = payload;
    if (!workspacePath || !slot) {
      throw new Error("workspacePath and slot are required");
    }
    const key = this.sessionKey(workspacePath, slot);
    const existingSessionId = this.sessionIndex.get(key);
    if (existingSessionId) {
      const session = this.sessions.get(existingSessionId);
      if (session && !session.disposed) {
        session.subscribers.add(client);
        client.subscribedSessions.add(session.id);
        const pending = session.pendingOutput;
        session.pendingOutput = "";
        return {
          sessionId: session.id,
          workspacePath,
          slot,
          command: session.command,
          args: session.args,
          existing: true,
          pendingOutput: pending,
        };
      }
    }

    const sessionId = randomUUID();
    const finalArgs = args.length > 0 ? args : this.defaultShellArgs(command);
    const ptyProcess = this.createPty(command, finalArgs, {
      cols,
      rows,
      cwd: workspacePath,
      env: {
        ...process.env,
        ...env,
      },
    });

    const session: SessionDescriptor = {
      id: sessionId,
      workspacePath,
      slot,
      command,
      args: finalArgs,
      pty: ptyProcess,
      subscribers: new Set([client]),
      pendingOutput: "",
      disposed: false,
    };

    ptyProcess.onData((data: string) => {
      this.forwardData(session, data);
    });

    ptyProcess.onExit((event) => {
      this.forwardExit(session, event);
    });

    this.sessions.set(sessionId, session);
    this.sessionIndex.set(key, sessionId);
    client.subscribedSessions.add(sessionId);
    this.evaluateIdle();

    return {
      sessionId,
      workspacePath,
      slot,
      command,
      args: session.args,
      existing: false,
      pendingOutput: "",
    };
  }

  private forwardData(session: SessionDescriptor, data: string): void {
    if (!data) return;
    if (session.subscribers.size === 0) {
      session.pendingOutput = (session.pendingOutput + data).slice(-HISTORY_LIMIT);
      return;
    }
    const payload: HostDataEventPayload = { sessionId: session.id, data };
    this.broadcast(session.subscribers, {
      type: "event",
      event: "session-data",
      payload,
    });
  }

  private forwardExit(session: SessionDescriptor, event: { exitCode?: number | null; signal?: number | string | null }): void {
    const payload: HostExitEventPayload = {
      sessionId: session.id,
      exitCode: event?.exitCode ?? null,
      signal: typeof event?.signal === "string" ? event.signal : event?.signal != null ? String(event.signal) : null,
    };
    this.broadcast(session.subscribers, {
      type: "event",
      event: "session-exit",
      payload,
    });
    const key = this.sessionKey(session.workspacePath, session.slot);
    this.sessionIndex.delete(key);
    this.sessions.delete(session.id);
    session.disposed = true;
    try {
      session.pty.kill();
    } catch (error) {
      this.log("warn", `Failed to kill pty for session ${session.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.evaluateIdle();
  }

  private broadcast(targets: Set<ClientDescriptor>, message: TerminalHostEventMessage): void {
    const serialized = `${JSON.stringify(message)}\n`;
    for (const client of targets) {
      if (client.closed) continue;
      client.socket.write(serialized);
    }
  }

  private writeSession(payload: HostWritePayload): void {
    const session = this.sessions.get(payload.sessionId);
    if (!session || session.disposed) return;
    session.pty.write(payload.data);
  }

  private resizeSession(payload: HostResizePayload): void {
    const session = this.sessions.get(payload.sessionId);
    if (!session || session.disposed) return;
    try {
      session.pty.resize(payload.cols, payload.rows);
    } catch (error) {
      this.log("warn", `Failed to resize session ${session.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async disposeSession(payload: HostDisposePayload): Promise<void> {
    const session = this.sessions.get(payload.sessionId);
    if (!session) return;
    if (!session.disposed) {
      session.disposed = true;
      try {
        session.pty.kill();
      } catch (error) {
        this.log("warn", `Failed to dispose session ${session.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.sessions.delete(payload.sessionId);
    this.sessionIndex.delete(this.sessionKey(session.workspacePath, session.slot));
    const eventPayload: TerminalHostEventMessage = {
      type: "event",
      event: "session-disposed",
      payload: { sessionId: payload.sessionId, reason: payload.reason },
    };
    this.broadcast(session.subscribers, eventPayload);
    for (const client of session.subscribers) {
      client.subscribedSessions.delete(payload.sessionId);
    }
    this.evaluateIdle();
  }

  private releaseSession(client: ClientDescriptor, payload: HostReleasePayload): void {
    const session = this.sessions.get(payload.sessionId);
    if (!session) return;
    session.subscribers.delete(client);
    client.subscribedSessions.delete(session.id);
  }

  private listSessions(): HostListSessionsResult {
    const sessions = Array.from(this.sessions.values()).map((session) => ({
      sessionId: session.id,
      workspacePath: session.workspacePath,
      slot: session.slot,
      command: session.command,
      args: session.args,
      hasSubscribers: session.subscribers.size > 0,
    }));
    return { sessions };
  }

  private getWorkspaceState(workspacePath?: string): HostListSessionsResult {
    if (!workspacePath) {
      return this.listSessions();
    }
    const normalized = this.sessionKey(workspacePath, "");
    const prefix = `${normalized.split("::")[0]}::`;
    const sessions = Array.from(this.sessions.values())
      .filter((session) => this.sessionKey(session.workspacePath, session.slot).startsWith(prefix))
      .map((session) => ({
        sessionId: session.id,
        workspacePath: session.workspacePath,
        slot: session.slot,
        command: session.command,
        args: session.args,
        hasSubscribers: session.subscribers.size > 0,
      }));
    return { sessions };
  }

  private cleanupClient(client: ClientDescriptor): void {
    for (const sessionId of client.subscribedSessions) {
      const session = this.sessions.get(sessionId);
      if (!session) continue;
      session.subscribers.delete(client);
      if (session.subscribers.size === 0) {
        // keep session running; buffer future output
      }
    }
    client.subscribedSessions.clear();
    this.clients.delete(client.id);
    this.evaluateIdle();
  }

  private sendResponse(client: ClientDescriptor, message: TerminalHostResponseMessage): void {
    if (client.closed) return;
    client.socket.write(`${JSON.stringify(message)}\n`);
  }

  private defaultShellArgs(commandPath: string): string[] {
    const base = path.basename(commandPath);
    if (!base) return ["-i"];
    if (base.includes("fish")) return ["-i"];
    if (base.includes("powershell") || base.includes("pwsh")) {
      return ["-NoLogo"];
    }
    return ["-i"];
  }

  private sessionKey(workspacePath: string, slot: string): string {
    return `${path.resolve(workspacePath)}::${slot}`;
  }

  private evaluateIdle(): void {
    if (this.sessions.size === 0 && this.clients.size === 0) {
      if (!this.shutdownTimer) {
        this.shutdownTimer = setTimeout(() => {
          this.log("info", "No active sessions or clients; shutting down.");
          process.exit(0);
        }, IDLE_SHUTDOWN_MS);
      }
    } else if (this.shutdownTimer) {
      clearTimeout(this.shutdownTimer);
      this.shutdownTimer = null;
    }
  }

  private createPty(
    command: string,
    args: string[],
    options: { cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv },
  ): PtyAdapter {
    if (this.useFakePty || !realPty) {
      return new FakePty();
    }
    return realPty.spawn(command, args, {
      name: "xterm-color",
      cols: options.cols,
      rows: options.rows,
      cwd: options.cwd,
      env: options.env,
    });
  }
}

function main(): void {
  const socketPath = getHostSocketPath();
  const server = new TerminalHostServer(socketPath);
  server.start();
}

main();
