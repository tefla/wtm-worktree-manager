import { promises as fs } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const HISTORY_LIMIT = 40000;
const SAVE_DEBOUNCE_MS = 250;

function getStorePath(customPath?: string): string {
  if (customPath) {
    return resolve(customPath);
  }
  const home = homedir();
  return resolve(join(home, ".wtm", "terminals.json"));
}

export interface TerminalState {
  quickCommandExecuted: boolean;
  history: string;
  lastExitCode: number | null;
  lastSignal: string | null;
  updatedAt: number;
  label: string | null;
}

export interface WorkspaceTerminalState {
  activeTerminal: string | null;
  terminals: Record<string, TerminalState>;
  updatedAt: number;
}

export interface TerminalStoreData {
  workspaces: Record<string, WorkspaceTerminalState>;
}

export interface TerminalSessionStoreOptions {
  filePath?: string;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

class TerminalSessionStoreClass {
  filePath: string;
  data: TerminalStoreData | null;
  saveTimer: ReturnType<typeof setTimeout> | null;
  dirty: boolean;

  constructor(options: TerminalSessionStoreOptions = {}) {
    this.filePath = getStorePath(options.filePath ?? process.env.WTM_TERMINAL_STORE);
    this.data = null;
    this.saveTimer = null;
    this.dirty = false;
  }

  async configure(options: TerminalSessionStoreOptions = {}): Promise<void> {
    const nextPath = getStorePath(options.filePath ?? process.env.WTM_TERMINAL_STORE);
    if (nextPath === this.filePath) {
      return;
    }

    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    if (this.dirty) {
      try {
        await this.flush();
      } catch (error) {
        console.error("Failed to persist terminal sessions before reconfiguration", error);
      }
    }

    this.filePath = nextPath;
    this.data = null;
    this.dirty = false;
  }

  async load(): Promise<TerminalStoreData> {
    if (this.data) {
      return this.data;
    }

    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as TerminalStoreData;
      this.data = this.normalise(parsed);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        this.data = { workspaces: {} };
        await this.flush();
      } else {
        throw new Error(
          `Failed to load terminal session store from ${this.filePath}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return this.data;
  }

  normalise(raw: TerminalStoreData | unknown): TerminalStoreData {
    const source = raw && typeof raw === "object" ? (raw as TerminalStoreData) : { workspaces: {} };
    const workspaces = source.workspaces && typeof source.workspaces === "object" ? source.workspaces : {};
    const normalised: Record<string, WorkspaceTerminalState> = {};
    for (const [pathKey, value] of Object.entries(workspaces)) {
      if (!value || typeof value !== "object") continue;
      const resolvedPath = resolve(pathKey);
      const terminals = (value as WorkspaceTerminalState).terminals;
      const normalisedTerminals: Record<string, TerminalState> = {};
      for (const [slot, terminalState] of Object.entries(terminals || {})) {
        if (!terminalState || typeof terminalState !== "object") continue;
        const exitCodeRaw = (terminalState as TerminalState).lastExitCode;
        const signalRaw = (terminalState as TerminalState).lastSignal;
        const updatedAtRaw = (terminalState as TerminalState).updatedAt;
        const historyRaw = (terminalState as TerminalState).history;
        normalisedTerminals[slot] = {
          quickCommandExecuted: Boolean((terminalState as TerminalState).quickCommandExecuted),
          history: typeof historyRaw === "string" ? historyRaw.slice(-HISTORY_LIMIT) : "",
          lastExitCode:
            typeof exitCodeRaw === "number" && Number.isFinite(exitCodeRaw)
              ? exitCodeRaw
              : exitCodeRaw ?? null,
          lastSignal: typeof signalRaw === "string" ? signalRaw : signalRaw ?? null,
          updatedAt:
            typeof updatedAtRaw === "number" && Number.isFinite(updatedAtRaw) ? updatedAtRaw : Date.now(),
          label: typeof (terminalState as TerminalState).label === "string" ? (terminalState as TerminalState).label : null,
        };
      }
      normalised[resolvedPath] = {
        activeTerminal:
          typeof (value as WorkspaceTerminalState).activeTerminal === "string"
            ? (value as WorkspaceTerminalState).activeTerminal
            : null,
        terminals: normalisedTerminals,
        updatedAt:
          typeof (value as WorkspaceTerminalState).updatedAt === "number" &&
          Number.isFinite((value as WorkspaceTerminalState).updatedAt)
            ? (value as WorkspaceTerminalState).updatedAt
            : Date.now(),
      };
    }
    return { workspaces: normalised };
  }

  scheduleSave(): void {
    if (this.saveTimer) return;
    this.dirty = true;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flush().catch((error) => {
        console.error("Failed to persist terminal sessions", error);
      });
    }, SAVE_DEBOUNCE_MS);
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    await this.load();
    await mkdir(dirname(this.filePath), { recursive: true });
    const body = `${JSON.stringify(this.data, null, 2)}\n`;
    await fs.writeFile(this.filePath, body, "utf8");
    this.dirty = false;
  }

  normaliseWorkspaceKey(workspacePath: string): string {
    return resolve(workspacePath);
  }

  async ensureWorkspace(workspacePath: string): Promise<WorkspaceTerminalState> {
    const data = await this.load();
    const key = this.normaliseWorkspaceKey(workspacePath);
    if (!data.workspaces[key]) {
      data.workspaces[key] = {
        activeTerminal: null,
        terminals: {},
        updatedAt: Date.now(),
      };
      this.scheduleSave();
    }
    return data.workspaces[key];
  }

  async ensureTerminal(workspacePath: string, slot: string, metadata: { label?: string } = {}): Promise<TerminalState> {
    const workspace = await this.ensureWorkspace(workspacePath);
    if (!workspace.terminals[slot]) {
      workspace.terminals[slot] = {
        quickCommandExecuted: false,
        history: "",
        lastExitCode: null,
        lastSignal: null,
        updatedAt: Date.now(),
        label: null,
      };
      workspace.updatedAt = Date.now();
      this.scheduleSave();
    }
    const terminal = workspace.terminals[slot];
    if (metadata && typeof metadata === "object") {
      if (typeof metadata.label === "string") {
        const trimmed = metadata.label.trim();
        if (trimmed && terminal.label !== trimmed) {
          terminal.label = trimmed;
          terminal.updatedAt = Date.now();
          this.scheduleSave();
        }
      }
    }
    return terminal;
  }

  async setActiveTerminal(workspacePath: string, slot: string | null): Promise<void> {
    const workspace = await this.ensureWorkspace(workspacePath);
    workspace.activeTerminal = slot ?? null;
    workspace.updatedAt = Date.now();
    this.scheduleSave();
  }

  async markQuickCommand(workspacePath: string, slot: string): Promise<void> {
    const terminal = await this.ensureTerminal(workspacePath, slot);
    if (!terminal.quickCommandExecuted) {
      terminal.quickCommandExecuted = true;
      terminal.updatedAt = Date.now();
      this.scheduleSave();
    }
  }

  async appendHistory(workspacePath: string, slot: string, chunk: string): Promise<void> {
    if (!chunk) return;
    const terminal = await this.ensureTerminal(workspacePath, slot);
    terminal.history = (terminal.history || "").concat(chunk).slice(-HISTORY_LIMIT);
    terminal.updatedAt = Date.now();
    this.scheduleSave();
  }

  async markExit(workspacePath: string, slot: string, exitCode: number | null, signal?: string | null): Promise<void> {
    const terminal = await this.ensureTerminal(workspacePath, slot);
    terminal.lastExitCode = exitCode;
    terminal.lastSignal = signal ?? null;
    terminal.updatedAt = Date.now();
    this.scheduleSave();
  }

  async clearTerminal(workspacePath: string, slot: string): Promise<void> {
    const data = await this.load();
    const key = this.normaliseWorkspaceKey(workspacePath);
    const workspace = data.workspaces[key];
    if (!workspace) return;
    if (workspace.terminals[slot]) {
      delete workspace.terminals[slot];
      workspace.updatedAt = Date.now();
      if (workspace.activeTerminal === slot) {
        workspace.activeTerminal = null;
      }
      if (Object.keys(workspace.terminals).length === 0) {
        delete data.workspaces[key];
      }
      this.scheduleSave();
    }
  }

  async clearWorkspace(workspacePath: string): Promise<void> {
    const data = await this.load();
    const key = this.normaliseWorkspaceKey(workspacePath);
    if (data.workspaces[key]) {
      delete data.workspaces[key];
      this.scheduleSave();
    }
  }

  async listWorkspaces(): Promise<string[]> {
    const data = await this.load();
    return Object.keys(data.workspaces);
  }

  async listSessionsForWorkspace(workspacePath: string): Promise<Record<string, TerminalState>> {
    const workspace = await this.ensureWorkspace(workspacePath);
    return clone(workspace.terminals);
  }

  async getWorkspaceState(workspacePath: string): Promise<WorkspaceTerminalState> {
    const workspace = await this.ensureWorkspace(workspacePath);
    return clone(workspace);
  }

  async markQuickCommandExecuted(workspacePath: string, slot: string): Promise<void> {
    await this.markQuickCommand(workspacePath, slot);
  }

  async setActiveTerminalSlot(workspacePath: string, slot: string | null): Promise<void> {
    await this.setActiveTerminal(workspacePath, slot);
  }

  async clearWorkspaceState(workspacePath: string): Promise<void> {
    await this.clearWorkspace(workspacePath);
  }
}

export const terminalSessionStore = new TerminalSessionStoreClass();
export type TerminalSessionStore = TerminalSessionStoreClass;
