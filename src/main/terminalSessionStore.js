const { promises: fs } = require("node:fs");
const { mkdir } = require("node:fs/promises");
const { homedir } = require("node:os");
const { dirname, join, resolve } = require("node:path");

const HISTORY_LIMIT = 40000;
const SAVE_DEBOUNCE_MS = 250;

function getStorePath(customPath) {
  if (customPath) {
    return resolve(customPath);
  }
  const home = homedir();
  return resolve(join(home, ".wtm", "terminals.json"));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

class TerminalSessionStore {
  constructor(options = {}) {
    this.filePath = getStorePath(options.filePath ?? process.env.WTM_TERMINAL_STORE);
    this.data = null;
    this.saveTimer = null;
    this.dirty = false;
  }

  async load() {
    if (this.data) {
      return this.data;
    }

    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      this.data = this.normalise(parsed);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
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

  normalise(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    const workspaces = source.workspaces && typeof source.workspaces === "object" ? source.workspaces : {};
    const normalised = {};
    for (const [pathKey, value] of Object.entries(workspaces)) {
      if (!value || typeof value !== "object") continue;
      const resolvedPath = resolve(pathKey);
      const terminals = value.terminals && typeof value.terminals === "object" ? value.terminals : {};
      const normalisedTerminals = {};
      for (const [slot, terminalState] of Object.entries(terminals)) {
        if (!terminalState || typeof terminalState !== "object") continue;
        const exitCodeRaw = terminalState.lastExitCode;
        const signalRaw = terminalState.lastSignal;
        const updatedAtRaw = terminalState.updatedAt;
        const historyRaw = terminalState.history;
        normalisedTerminals[slot] = {
          quickCommandExecuted: Boolean(terminalState.quickCommandExecuted),
          history: typeof historyRaw === "string" ? historyRaw.slice(-HISTORY_LIMIT) : "",
          lastExitCode: typeof exitCodeRaw === "number" ? exitCodeRaw : exitCodeRaw ?? null,
          lastSignal: typeof signalRaw === "string" ? signalRaw : signalRaw ?? null,
          updatedAt:
            typeof updatedAtRaw === "number" && Number.isFinite(updatedAtRaw) ? updatedAtRaw : Date.now(),
          label: typeof terminalState.label === "string" ? terminalState.label : null,
        };
      }
      normalised[resolvedPath] = {
        activeTerminal: typeof value.activeTerminal === "string" ? value.activeTerminal : null,
        terminals: normalisedTerminals,
        updatedAt:
          typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt) ? value.updatedAt : Date.now(),
      };
    }
    return { workspaces: normalised };
  }

  scheduleSave() {
    if (this.saveTimer) return;
    this.dirty = true;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flush().catch((error) => {
        console.error("Failed to persist terminal sessions", error);
      });
    }, SAVE_DEBOUNCE_MS);
  }

  async flush() {
    if (!this.dirty) return;
    await this.load();
    await mkdir(dirname(this.filePath), { recursive: true });
    const body = `${JSON.stringify(this.data, null, 2)}\n`;
    await fs.writeFile(this.filePath, body, "utf8");
    this.dirty = false;
  }

  normaliseWorkspaceKey(workspacePath) {
    return resolve(workspacePath);
  }

  async ensureWorkspace(workspacePath) {
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

  async ensureTerminal(workspacePath, slot, metadata = {}) {
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

  async setActiveTerminal(workspacePath, slot) {
    const workspace = await this.ensureWorkspace(workspacePath);
    workspace.activeTerminal = slot ?? null;
    workspace.updatedAt = Date.now();
    this.scheduleSave();
  }

  async markQuickCommand(workspacePath, slot) {
    const terminal = await this.ensureTerminal(workspacePath, slot);
    if (!terminal.quickCommandExecuted) {
      terminal.quickCommandExecuted = true;
      terminal.updatedAt = Date.now();
      this.scheduleSave();
    }
  }

  async appendHistory(workspacePath, slot, chunk) {
    if (!chunk) return;
    const terminal = await this.ensureTerminal(workspacePath, slot);
    terminal.history = (terminal.history || "").concat(chunk).slice(-HISTORY_LIMIT);
    terminal.updatedAt = Date.now();
    this.scheduleSave();
  }

  async markExit(workspacePath, slot, exitCode, signal) {
    const terminal = await this.ensureTerminal(workspacePath, slot);
    terminal.lastExitCode = exitCode;
    terminal.lastSignal = signal ?? null;
    terminal.updatedAt = Date.now();
    this.scheduleSave();
  }

  async clearTerminal(workspacePath, slot) {
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

  async clearWorkspace(workspacePath) {
    const data = await this.load();
    const key = this.normaliseWorkspaceKey(workspacePath);
    if (data.workspaces[key]) {
      delete data.workspaces[key];
      this.scheduleSave();
    }
  }

  async getWorkspaceState(workspacePath) {
    const data = await this.load();
    const key = this.normaliseWorkspaceKey(workspacePath);
    const workspace = data.workspaces[key];
    if (!workspace) {
      return {
        activeTerminal: null,
        terminals: {},
      };
    }
    return clone(workspace);
  }

  async listWorkspaces() {
    const data = await this.load();
    return Object.entries(data.workspaces).map(([pathKey, workspace]) => ({
      workspacePath: pathKey,
      activeTerminal: workspace.activeTerminal ?? null,
      terminals: clone(workspace.terminals),
      updatedAt: workspace.updatedAt,
    }));
  }
}

const terminalSessionStore = new TerminalSessionStore();

module.exports = {
  terminalSessionStore,
  TerminalSessionStore,
};
