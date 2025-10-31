import { spawn, type IPty } from "node-pty";
import { EventEmitter } from "node:events";
import os from "node:os";

export interface PtyDescriptor {
  workspaceId: string;
  tabId: string;
  label: string;
  path: string;
}

export interface PtyDataEvent {
  workspaceId: string;
  tabId: string;
  data: string;
}

export interface PtyExitEvent {
  workspaceId: string;
  tabId: string;
  exitCode: number;
}

export class PtyManager extends EventEmitter {
  private ptys: Map<string, IPty> = new Map(); // key: workspaceId:tabId
  private buffers: Map<string, string> = new Map(); // Accumulated raw output
  private readonly maxBufferChars = 100000; // Keep last 100k characters

  private getKey(workspaceId: string, tabId: string): string {
    return `${workspaceId}:${tabId}`;
  }

  createPty(descriptor: PtyDescriptor): void {
    const key = this.getKey(descriptor.workspaceId, descriptor.tabId);

    // Don't recreate if already exists
    if (this.ptys.has(key)) {
      return;
    }

    // Spawn a new pty
    const shell = process.env.SHELL || "/bin/bash";
    const ptyProcess = spawn(shell, [], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: descriptor.path,
      env: process.env as Record<string, string>,
    });

    // Initialize buffer
    this.buffers.set(key, "");

    // Listen for data
    ptyProcess.onData((data) => {
      // Accumulate raw data in buffer
      let buffer = this.buffers.get(key) || "";
      buffer += data;

      // Trim buffer if too large (keep last N characters)
      if (buffer.length > this.maxBufferChars) {
        buffer = buffer.slice(-this.maxBufferChars);
      }

      this.buffers.set(key, buffer);

      // Emit data event
      this.emit("data", {
        workspaceId: descriptor.workspaceId,
        tabId: descriptor.tabId,
        data,
      } as PtyDataEvent);
    });

    // Listen for exit
    ptyProcess.onExit(({ exitCode }) => {
      this.emit("exit", {
        workspaceId: descriptor.workspaceId,
        tabId: descriptor.tabId,
        exitCode,
      } as PtyExitEvent);

      // Clean up
      this.ptys.delete(key);
    });

    this.ptys.set(key, ptyProcess);
  }

  write(workspaceId: string, tabId: string, data: string): void {
    const key = this.getKey(workspaceId, tabId);
    const pty = this.ptys.get(key);
    if (pty) {
      pty.write(data);
    }
  }

  resize(workspaceId: string, tabId: string, cols: number, rows: number): void {
    const key = this.getKey(workspaceId, tabId);
    const pty = this.ptys.get(key);
    if (pty) {
      pty.resize(cols, rows);
    }
  }

  getBuffer(workspaceId: string, tabId: string): string[] {
    const key = this.getKey(workspaceId, tabId);
    const rawBuffer = this.buffers.get(key) || "";

    // Split into lines, handling both \r\n and \n
    // Replace \r\n with \n first, then split by \n
    const normalized = rawBuffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = normalized.split("\n");

    return lines;
  }

  kill(workspaceId: string, tabId: string): void {
    const key = this.getKey(workspaceId, tabId);
    const pty = this.ptys.get(key);
    if (pty) {
      pty.kill();
      this.ptys.delete(key);
      this.buffers.delete(key);
    }
  }

  killAll(): void {
    for (const pty of this.ptys.values()) {
      pty.kill();
    }
    this.ptys.clear();
    this.buffers.clear();
  }

  hasPty(workspaceId: string, tabId: string): boolean {
    const key = this.getKey(workspaceId, tabId);
    return this.ptys.has(key);
  }
}
