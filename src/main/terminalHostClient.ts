import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { Socket, connect as netConnect } from "node:net";
import path from "node:path";
import process from "node:process";
import { spawn, ChildProcess } from "node:child_process";
import {
  HostConfigurePayload,
  HostDisposePayload,
  HostEnsureSessionPayload,
  HostEnsureSessionResult,
  HostListSessionsResult,
  HostReleasePayload,
  HostResizePayload,
  HostWritePayload,
  TerminalHostEventMessage,
  TerminalHostMessage,
  TerminalHostRequestMessage,
  TerminalHostResponseMessage,
} from "./terminalHostProtocol";
import { getHostEntrypointDir, getHostSocketPath } from "./terminalHostPaths";

export interface TerminalHostClientEvents {
  "session-data": (payload: { sessionId: string; data: string }) => void;
  "session-exit": (payload: { sessionId: string; exitCode: number | null; signal: string | null }) => void;
  "session-disposed": (payload: { sessionId: string; reason?: string }) => void;
  error: (error: Error) => void;
}

type EventKeys = keyof TerminalHostClientEvents;
type EventListener<K extends EventKeys> = TerminalHostClientEvents[K];

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class TerminalHostClient extends EventEmitter {
  private socket: Socket | null;
  private buffer: string;
  private connecting: Promise<void> | null;
  private requests: Map<string, PendingRequest>;
  private spawnedProcess: ChildProcess | null;

  constructor() {
    super();
    this.socket = null;
    this.buffer = "";
    this.connecting = null;
    this.requests = new Map();
    this.spawnedProcess = null;
  }

  override on<K extends EventKeys>(eventName: K, listener: EventListener<K>): this {
    return super.on(eventName, listener);
  }

  override once<K extends EventKeys>(eventName: K, listener: EventListener<K>): this {
    return super.once(eventName, listener);
  }

  override off<K extends EventKeys>(eventName: K, listener: EventListener<K>): this {
    return super.off(eventName, listener);
  }

  async configure(payload: HostConfigurePayload): Promise<void> {
    await this.sendRequest("configure", payload);
  }

  async ensureSession(payload: HostEnsureSessionPayload): Promise<HostEnsureSessionResult> {
    const result = await this.sendRequest("ensureSession", payload);
    return result as HostEnsureSessionResult;
  }

  async releaseSession(payload: HostReleasePayload): Promise<void> {
    await this.sendRequest("releaseSession", payload);
  }

  async write(payload: HostWritePayload): Promise<void> {
    await this.sendRequest("writeSession", payload);
  }

  async resize(payload: HostResizePayload): Promise<void> {
    await this.sendRequest("resizeSession", payload);
  }

  async dispose(payload: HostDisposePayload): Promise<void> {
    await this.sendRequest("disposeSession", payload);
  }

  async listSessions(): Promise<HostListSessionsResult> {
    const result = await this.sendRequest("listSessions", {});
    return result as HostListSessionsResult;
  }

  private async sendRequest(command: TerminalHostRequestMessage["command"], payload: unknown): Promise<unknown> {
    await this.ensureConnected();
    const id = randomUUID();
    const body: TerminalHostRequestMessage = {
      type: "request",
      id,
      command,
      payload,
    };
    const serialized = `${JSON.stringify(body)}\n`;

    return await new Promise<unknown>((resolve, reject) => {
      if (!this.socket) {
        reject(new Error("Socket unavailable"));
        return;
      }
      this.requests.set(id, { resolve, reject });
      this.socket.write(serialized, (error) => {
        if (error) {
          this.requests.delete(id);
          reject(error);
        }
      });
    });
  }

  private async ensureConnected(): Promise<void> {
    if (this.socket && !this.socket.destroyed) {
      return;
    }
    if (this.connecting) {
      await this.connecting;
      return;
    }
    this.connecting = this.connect();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private async connect(): Promise<void> {
    const socketPath = getHostSocketPath();
    if (process.platform !== "win32") {
      const dir = path.dirname(socketPath);
      mkdirSync(dir, { recursive: true });
    }
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        await this.openSocket(socketPath);
        return;
      } catch (error) {
        await this.spawnHostProcess();
        const backoff = 150 + attempt * 100;
        await this.delay(backoff);
      }
    }
    throw new Error("Failed to connect to terminal host");
  }

  private async openSocket(socketPath: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = netConnect(socketPath, () => {
        this.attachSocket(socket);
        resolve();
      });
      socket.on("error", (error) => {
        socket.destroy();
        reject(error);
      });
    });
  }

  private attachSocket(socket: Socket): void {
    this.socket = socket;
    this.buffer = "";

    socket.on("data", (chunk) => {
      this.buffer += chunk.toString("utf8");
      let newlineIndex: number;
      while ((newlineIndex = this.buffer.indexOf("\n")) >= 0) {
        const raw = this.buffer.slice(0, newlineIndex).trim();
        this.buffer = this.buffer.slice(newlineIndex + 1);
        if (!raw) continue;
        try {
          const message = JSON.parse(raw) as TerminalHostMessage;
          this.handleMessage(message);
        } catch (error) {
          this.emit("error", new Error(`Failed to parse host message: ${error instanceof Error ? error.message : String(error)}`));
        }
      }
    });

    socket.on("close", () => {
      this.socket = null;
      this.rejectAllPending(new Error("Connection to terminal host closed"));
    });

    socket.on("error", (error) => {
      this.emit("error", error as Error);
    });
  }

  private handleMessage(message: TerminalHostMessage): void {
    switch (message.type) {
      case "response":
        this.handleResponse(message);
        break;
      case "event":
        this.handleEvent(message);
        break;
      default:
        break;
    }
  }

  private handleResponse(message: TerminalHostResponseMessage): void {
    const pending = this.requests.get(message.id);
    if (!pending) {
      return;
    }
    this.requests.delete(message.id);
    if (message.ok) {
      pending.resolve(message.result);
    } else {
      pending.reject(new Error(message.error?.message ?? "Unknown host error"));
    }
  }

  private handleEvent(message: TerminalHostEventMessage): void {
    switch (message.event) {
      case "session-data":
        this.emit("session-data", message.payload as { sessionId: string; data: string });
        break;
      case "session-exit":
        this.emit("session-exit", message.payload as { sessionId: string; exitCode: number | null; signal: string | null });
        break;
      case "session-disposed":
        this.emit("session-disposed", message.payload as { sessionId: string; reason?: string });
        break;
      default:
        break;
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.requests.entries()) {
      this.requests.delete(id);
      pending.reject(error);
    }
  }

  private async spawnHostProcess(): Promise<void> {
    if (this.spawnedProcess && !this.spawnedProcess.killed) {
      return;
    }
    const entryDir = getHostEntrypointDir();
    const entry = path.join(entryDir, "terminalHost.js");
    const child = spawn(process.execPath, [entry], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        WTM_TERMINAL_HOST_SOCKET: getHostSocketPath(),
      },
    });
    child.unref();
    this.spawnedProcess = child;
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
