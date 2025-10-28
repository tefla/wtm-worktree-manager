import React, { FormEvent, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type {
  EnsureTerminalResponse,
  QuickAccessEntry,
  SettingsResponse,
  TerminalDataPayload,
  TerminalExitPayload,
  WorkspaceStateResponse,
  WorkspaceSummary,
} from "./types";

type ToastKind = "info" | "success" | "error";

interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

interface TerminalDefinition {
  key: string;
  label: string;
  quickCommand: string | null;
  isEphemeral: boolean;
}

interface SavedTerminalState {
  history?: string;
  quickCommandExecuted?: boolean;
  lastExitCode?: number | null;
  lastSignal?: string | null;
  label?: string | null;
}

interface SavedWorkspaceState {
  workspacePath: string;
  activeTerminal: string | null;
  terminals: Record<string, SavedTerminalState>;
}

interface TerminalRecord {
  key: string;
  label: string;
  quickCommand: string | null;
  isEphemeral: boolean;
  sessionId: string | null;
  quickCommandExecuted: boolean;
  lastExitCode: number | null;
  lastSignal: string | null;
  savedHistory: string;
  ignoreSavedHistory: boolean;
  closed: boolean;
  shouldStart: boolean;
}

interface WorkspaceTabState {
  workspace: WorkspaceSummary;
  terminalOrder: string[];
  terminals: Map<string, TerminalRecord>;
  activeTerminalKey: string | null;
  savedState: SavedWorkspaceState;
  ephemeralCounter: number;
}

interface SessionIndexEntry {
  workspacePath: string;
  terminalKey: string;
}

interface TerminalRuntime {
  terminal: Terminal;
  fitAddon: FitAddon;
  resizeObserver: ResizeObserver;
  container: HTMLDivElement;
}

const TERMINAL_HISTORY_LIMIT = 40000;
const TERMINAL_FONT_FAMILY = '"JetBrains Mono", "Fira Code", "SFMono-Regular", monospace';
const TERMINAL_THEME = {
  background: "#070d1d",
  foreground: "#d1d5db",
  cursor: "#38bdf8",
  selectionBackground: "#1e293b",
};

function cx(...values: Array<string | null | undefined | false | Record<string, boolean>>): string {
  const classes: string[] = [];
  for (const value of values) {
    if (!value) continue;
    if (typeof value === "string") {
      classes.push(value);
      continue;
    }
    for (const [key, active] of Object.entries(value)) {
      if (active) {
        classes.push(key);
      }
    }
  }
  return classes.join(" ").trim();
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normaliseQuickAccessList(list: unknown, options: { fallbackToDefault?: boolean } = {}): TerminalDefinition[] {
  const { fallbackToDefault = false } = options;
  const source = Array.isArray(list) ? (list as QuickAccessEntry[]) : [];
  const normalized: TerminalDefinition[] = [];
  const seenKeys = new Set<string>();

  source.forEach((entry, index) => {
    const label = typeof entry?.label === "string" ? entry.label.trim() : "";
    const command = typeof entry?.quickCommand === "string" ? entry.quickCommand.trim() : "";
    if (!label && !command) {
      return;
    }
    const baseKey = entry?.key && typeof entry.key === "string" ? entry.key.trim() : slugify(label || command);
    let key = baseKey || `slot-${index + 1}`;
    let counter = 1;
    while (seenKeys.has(key)) {
      key = `${baseKey || `slot-${index + 1}`}-${(counter += 1)}`;
    }
    seenKeys.add(key);
    normalized.push({
      key,
      label: label || command || `Command ${index + 1}`,
      quickCommand: command || null,
      isEphemeral: false,
    });
  });

  if (normalized.length === 0 && fallbackToDefault) {
    return [
      { key: "npm-install", label: "npm i", quickCommand: "npm i", isEphemeral: false },
      {
        key: "lerna-bootstrap",
        label: "npm run lerna:bootstrap",
        quickCommand: "npm run lerna:bootstrap",
        isEphemeral: false,
      },
    ];
  }

  return normalized;
}

function buildStatusTooltip(status: WorkspaceSummary["status"]): string {
  if (!status) {
    return "Status unavailable";
  }

  const lines: string[] = [];
  const changeCount = status.changeCount ?? 0;

  if (status.clean) {
    const cleanLabel =
      status.summary && status.summary.trim().toLowerCase() !== "clean"
        ? status.summary.trim()
        : "Clean working tree";
    lines.push(cleanLabel);
  } else if (changeCount > 0) {
    lines.push(`${changeCount} uncommitted change${changeCount === 1 ? "" : "s"}`);
  } else if (status.summary) {
    lines.push(status.summary.trim());
  }

  if (!status.clean && Array.isArray(status.sampleChanges) && status.sampleChanges.length > 0) {
    lines.push(...status.sampleChanges.slice(0, 5).map((line) => line.trim()));
  }

  const filtered = lines
    .map((line) => (typeof line === "string" ? line.trim() : ""))
    .filter((line, index, arr) => line && arr.indexOf(line) === index);

  if (filtered.length === 0) {
    filtered.push("Status unavailable");
  }

  return filtered.join("\n");
}

function buildStatusIcons(workspace: WorkspaceSummary): Array<{ className: string; text: string; tooltip: string }> {
  const status = workspace.status;
  if (workspace.kind === "folder") {
    return [{ className: "status-icon folder", text: "📁", tooltip: "Folder not linked to a git worktree" }];
  }

  const tooltip = buildStatusTooltip(status);
  const icons: Array<{ className: string; text: string; tooltip: string }> = [];
  if (status.clean) {
    icons.push({ className: "status-icon clean", text: "✔", tooltip });
  } else {
    const changeCount = status.changeCount ?? 0;
    const warningText = changeCount > 0 ? `⚠${String(changeCount)}` : "⚠";
    icons.push({ className: "status-icon dirty", text: warningText, tooltip });
  }

  if (status.ahead) {
    icons.push({
      className: "status-icon ahead",
      text: `↑${status.ahead}`,
      tooltip: `Ahead by ${status.ahead} commit${status.ahead === 1 ? "" : "s"}`,
    });
  }

  if (status.behind) {
    icons.push({
      className: "status-icon behind",
      text: `↓${status.behind}`,
      tooltip: `Behind by ${status.behind} commit${status.behind === 1 ? "" : "s"}`,
    });
  }

  if (icons.length === 0) {
    icons.push({ className: "status-icon", text: "•", tooltip: "No status information" });
  }

  return icons;
}

function runtimeKey(workspacePath: string, terminalKey: string): string {
  return `${workspacePath}::${terminalKey}`;
}

function ensureSavedWorkspaceState(workspacePath: string, saved?: WorkspaceStateResponse | null): SavedWorkspaceState {
  if (!saved || typeof saved !== "object") {
    return { workspacePath, activeTerminal: null, terminals: {} };
  }
  const terminals = saved.terminals && typeof saved.terminals === "object" ? saved.terminals : {};
  return {
    workspacePath,
    activeTerminal: saved.activeTerminal ?? null,
    terminals: { ...terminals },
  };
}

function buildWorkspaceDetailTooltip(workspace: WorkspaceSummary): string {
  const status = workspace.status;
  const branchLabel = workspace.branch || workspace.relativePath || "Detached HEAD";
  const lines: string[] = [
    `Branch: ${branchLabel}`,
    `Worktree: ${workspace.relativePath || "—"}`,
    `Path: ${workspace.path}`,
    `HEAD: ${workspace.headSha || "—"}`,
    status.upstream ? `Upstream: ${status.upstream}` : "Upstream: —",
    `Status: ${status.summary}`,
  ];

  if (!status.clean && status.changeCount) {
    lines.push(`${status.changeCount} uncommitted change${status.changeCount === 1 ? "" : "s"}`);
  }

  if (workspace.lastCommit) {
    lines.push(
      `Last commit: ${workspace.lastCommit.shortSha} ${workspace.lastCommit.relativeTime} — ${workspace.lastCommit.subject}`,
    );
  }

  if (!status.clean && Array.isArray(status.sampleChanges) && status.sampleChanges.length > 0) {
    lines.push("Changes:");
    status.sampleChanges.slice(0, 5).forEach((change) => {
      lines.push(` • ${change}`);
    });
  }

  return lines.join("\n");
}

function useStableCallback<T extends (...args: any[]) => any>(callback: T): T {
  const ref = useRef<T>(callback);
  ref.current = callback;
  return useCallback(((...args: Parameters<T>) => ref.current(...args)) as T, []);
}

const TerminalPlaceholder: React.FC = () => (
  <div className="terminal-placeholder">
    Select a quick action or use the + button to start a terminal.
  </div>
);

interface TerminalPanelProps {
  workspacePath: string;
  record: TerminalRecord;
  isActive: boolean;
  onStart: (workspacePath: string, record: TerminalRecord, container: HTMLDivElement) => void;
  onDispose: (workspacePath: string, record: TerminalRecord) => void;
}

const TerminalPanel: React.FC<TerminalPanelProps> = ({ workspacePath, record, isActive, onStart, onDispose }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const onStartStable = useStableCallback(onStart);
  const onDisposeStable = useStableCallback(onDispose);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    if (record.shouldStart || record.sessionId) {
      onStartStable(workspacePath, record, container);
    }
  }, [record, workspacePath, onStartStable, record.shouldStart, record.sessionId]);

  useEffect(
    () => () => {
      onDisposeStable(workspacePath, record);
    },
    [workspacePath, record, onDisposeStable],
  );

  return (
    <div className={cx("terminal-panel", { "is-active": isActive })} data-key={record.key}>
      <div ref={containerRef} className="terminal-view" />
    </div>
  );
};

function App(): JSX.Element {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [branchInput, setBranchInput] = useState("");
  const [baseInput, setBaseInput] = useState("");
  const [createInFlight, setCreateInFlight] = useState(false);
  const [environments, setEnvironments] = useState<SettingsResponse["environments"]>({});
  const [activeEnvironment, setActiveEnvironment] = useState<string>("");
  const defaultTerminalsRef = useRef<TerminalDefinition[]>([]);
  const [workspaceOrder, setWorkspaceOrder] = useState<string[]>([]);
  const [activeWorkspacePath, setActiveWorkspacePath] = useState<string | null>(null);
  const workspaceTabsRef = useRef<Map<string, WorkspaceTabState>>(new Map());
  const sessionIndexRef = useRef<Map<string, SessionIndexEntry>>(new Map());
  const runtimeRef = useRef<Map<string, TerminalRuntime>>(new Map());
  const [toastList, setToastList] = useState<Toast[]>([]);
  const toastIdRef = useRef(0);
  const [renderTicker, forceRender] = useReducer((value) => value + 1, 0);

  const pushToast = useCallback((message: string, kind: ToastKind = "info") => {
    toastIdRef.current += 1;
    const id = toastIdRef.current;
    setToastList((prev) => [...prev, { id, kind, message }]);
    setTimeout(() => {
      setToastList((prev) => prev.filter((toast) => toast.id !== id));
    }, kind === "error" ? 5600 : 4200);
  }, []);

  const reopenWorkspaceTab = useCallback(
    (workspace: WorkspaceSummary) => {
      const existing = workspaceTabsRef.current.get(workspace.path);
      if (!existing) {
        return;
      }
      existing.workspace = workspace;
      forceRender();
    },
    [forceRender],
  );

  const loadWorkspaces = useCallback(async (): Promise<WorkspaceSummary[]> => {
    setLoadingWorkspaces(true);
    let list: WorkspaceSummary[] = [];
    try {
      list = await window.workspaceAPI.list();
      setWorkspaces(list);
      list.forEach((workspace) => reopenWorkspaceTab(workspace));
      setActiveWorkspacePath((current) => {
        if (list.length === 0) {
          return null;
        }
        if (current && list.some((item) => item.path === current)) {
          return current;
        }
        return list[0].path;
      });
    } catch (error) {
      console.error("Failed to load workspaces", error);
      pushToast("Failed to load workspaces", "error");
    } finally {
      setLoadingWorkspaces(false);
    }
    return list;
  }, [pushToast, reopenWorkspaceTab]);

  const loadSettings = useCallback(async () => {
    try {
      const response = await window.settingsAPI.listEnvironments();
      setEnvironments(response.environments);
      setActiveEnvironment(response.activeEnvironment);
      const normalized = normaliseQuickAccessList(response.quickAccess, { fallbackToDefault: true });
      defaultTerminalsRef.current = normalized;
    } catch (error) {
      console.error("Failed to load settings", error);
      pushToast("Failed to load settings", "error");
    }
  }, [pushToast]);

  const generateEphemeralLabel = useCallback((workspaceState: WorkspaceTabState): string => {
    const label = `Terminal ${workspaceState.ephemeralCounter}`;
    workspaceState.ephemeralCounter += 1;
    return label;
  }, []);

  const generateEphemeralKey = useCallback((workspaceState: WorkspaceTabState): string => {
    const seen = workspaceState.terminals;
    const hasRandomUUID = typeof window.crypto?.randomUUID === "function";
    let candidate = "";
    let attempts = 0;
    do {
      if (hasRandomUUID) {
        candidate = `custom-${window.crypto.randomUUID()}`;
      } else {
        const salt = Math.floor(Math.random() * 1e6 + attempts);
        candidate = `custom-${Date.now().toString(36)}-${salt.toString(36)}`;
      }
      attempts += 1;
    } while (seen.has(candidate));
    return candidate;
  }, []);

  const registerEphemeralLabel = useCallback((workspaceState: WorkspaceTabState, label: string) => {
    if (!label) {
      return;
    }
    const match = /([0-9]+)\s*$/.exec(label);
    if (!match) {
      return;
    }
    const value = Number.parseInt(match[1], 10);
    if (Number.isFinite(value) && value + 1 > workspaceState.ephemeralCounter) {
      workspaceState.ephemeralCounter = value + 1;
    }
  }, []);

  const setupTerminalRecord = useCallback(
    (workspaceState: WorkspaceTabState, definition: TerminalDefinition): TerminalRecord => {
      const existing = workspaceState.terminals.get(definition.key);
      if (existing) {
        existing.label = definition.label;
        existing.quickCommand = definition.quickCommand;
        existing.isEphemeral = definition.isEphemeral;
        return existing;
      }

      const saved = workspaceState.savedState.terminals?.[definition.key];
      const label =
        (saved?.label && typeof saved.label === "string" && saved.label.trim()) || definition.label || definition.key;

      const record: TerminalRecord = {
        key: definition.key,
        label,
        quickCommand: definition.quickCommand,
        isEphemeral: definition.isEphemeral,
        sessionId: null,
        quickCommandExecuted: Boolean(saved?.quickCommandExecuted),
        lastExitCode: saved?.lastExitCode ?? null,
        lastSignal: saved?.lastSignal ?? null,
        savedHistory: saved?.history ?? "",
        ignoreSavedHistory: false,
        closed: false,
        shouldStart: false,
      };

      workspaceState.terminals.set(definition.key, record);
      workspaceState.terminalOrder.push(definition.key);

      if (workspaceState.savedState.terminals) {
        workspaceState.savedState.terminals[definition.key] = {
          ...(workspaceState.savedState.terminals[definition.key] || {}),
          label: record.label,
        };
      }

      if (record.isEphemeral) {
        registerEphemeralLabel(workspaceState, record.label);
      }

      return record;
    },
    [registerEphemeralLabel],
  );

  const disposeTerminalRuntime = useCallback(
    (workspacePath: string, record: TerminalRecord, preserveSession: boolean) => {
      const key = runtimeKey(workspacePath, record.key);
      const runtime = runtimeRef.current.get(key);
      if (runtime) {
        runtime.resizeObserver.disconnect();
        runtime.terminal.dispose();
        runtimeRef.current.delete(key);
      }
      if (record.sessionId) {
        sessionIndexRef.current.delete(record.sessionId);
        void window.terminalAPI
          .dispose(record.sessionId, { preserve: preserveSession })
          .catch((error) => console.warn("Failed to dispose terminal", error));
        record.sessionId = null;
      }
      record.closed = true;
    },
    [],
  );

  const setActiveTerminal = useCallback(
    (workspaceState: WorkspaceTabState, terminalKey: string | null) => {
      workspaceState.activeTerminalKey = terminalKey;
      forceRender();
      void window.terminalAPI
        .setActiveTerminal(workspaceState.workspace.path, terminalKey)
        .catch((error) => console.warn("Failed to persist active terminal", error));
    },
    [],
  );

  const handleTerminalClose = useCallback(
    (workspacePath: string, terminalKey: string) => {
      const workspaceState = workspaceTabsRef.current.get(workspacePath);
      if (!workspaceState) {
        return;
      }
      const record = workspaceState.terminals.get(terminalKey);
      if (!record) {
        return;
      }

      const wasActive = workspaceState.activeTerminalKey === terminalKey;
      disposeTerminalRuntime(workspacePath, record, !record.isEphemeral);

      if (record.isEphemeral) {
        workspaceState.terminals.delete(terminalKey);
        workspaceState.terminalOrder = workspaceState.terminalOrder.filter((key) => key !== terminalKey);
        if (workspaceState.savedState.terminals) {
          delete workspaceState.savedState.terminals[terminalKey];
        }
      } else {
        record.savedHistory = "";
        record.ignoreSavedHistory = true;
      }

      if (wasActive) {
        const fallback = workspaceState.terminalOrder.find((key) => key !== terminalKey) ?? null;
        setActiveTerminal(workspaceState, fallback);
      } else {
        forceRender();
      }
    },
    [disposeTerminalRuntime, setActiveTerminal],
  );

  const startTerminalSession = useCallback(
    async (workspaceState: WorkspaceTabState, record: TerminalRecord, container: HTMLDivElement) => {
      const key = runtimeKey(workspaceState.workspace.path, record.key);
      if (runtimeRef.current.has(key) && record.sessionId && !record.closed) {
        return;
      }

      record.shouldStart = false;
      record.closed = false;

      const terminal = new Terminal({
        convertEol: true,
        fontSize: 12,
        fontFamily: TERMINAL_FONT_FAMILY,
        theme: TERMINAL_THEME,
        scrollback: 4000,
      });

      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);

      terminal.open(container);
      fitAddon.fit();

      let sessionInfo: EnsureTerminalResponse;
      try {
        sessionInfo = await window.terminalAPI.ensureSession({
          workspacePath: workspaceState.workspace.path,
          slot: record.key,
          cols: terminal.cols,
          rows: terminal.rows,
          label: record.label,
        });
      } catch (error) {
        console.error("Failed to create terminal session", error);
        pushToast(`Failed to start terminal '${record.label}'`, "error");
        terminal.dispose();
        record.closed = true;
        forceRender();
        return;
      }

      record.sessionId = sessionInfo.sessionId;
      record.quickCommandExecuted = record.quickCommandExecuted || Boolean(sessionInfo.quickCommandExecuted);
      record.lastExitCode = sessionInfo.lastExitCode ?? null;
      record.lastSignal = sessionInfo.lastSignal ?? null;
      record.closed = false;
      record.savedHistory = "";

      sessionIndexRef.current.set(sessionInfo.sessionId, {
        workspacePath: workspaceState.workspace.path,
        terminalKey: record.key,
      });

      terminal.onData((data) => {
        if (record.sessionId) {
          window.terminalAPI.write(record.sessionId, data);
        }
      });

      const resizeObserver = new ResizeObserver(() => {
        fitAddon.fit();
        if (record.sessionId && !record.closed) {
          void window.terminalAPI
            .resize(record.sessionId, terminal.cols, terminal.rows)
            .catch((error) => console.warn("Failed to resize terminal", error));
        }
      });
      resizeObserver.observe(container);

      runtimeRef.current.set(key, { terminal, fitAddon, resizeObserver, container });

      void window.terminalAPI.resize(sessionInfo.sessionId, terminal.cols, terminal.rows).catch((error) => {
        console.warn("Failed to perform initial resize", error);
      });

      const historySource = record.ignoreSavedHistory ? sessionInfo.history : record.savedHistory || sessionInfo.history;
      if (historySource) {
        terminal.write(historySource);
      }
      record.ignoreSavedHistory = false;
      record.savedHistory = "";

      if (workspaceState.activeTerminalKey === record.key) {
        requestAnimationFrame(() => {
          fitAddon.fit();
          if (!record.closed) {
            terminal.focus();
          }
        });
      }

      if (record.quickCommand && !record.quickCommandExecuted) {
        setTimeout(() => {
          if (!record.sessionId) return;
          window.terminalAPI.write(record.sessionId, `${record.quickCommand}\n`);
          record.quickCommandExecuted = true;
          void window.terminalAPI
            .markQuickCommand(workspaceState.workspace.path, record.key)
            .catch((error) => console.warn("Failed to mark quick command as executed", error));
          forceRender();
        }, 30);
      }

      forceRender();
    },
    [pushToast],
  );

  const handleTerminalTabClick = useCallback(
    (workspacePath: string, terminalKey: string) => {
      const workspaceState = workspaceTabsRef.current.get(workspacePath);
      if (!workspaceState) return;
      const record = workspaceState.terminals.get(terminalKey);
      if (!record) return;

      if (!record.sessionId && !record.shouldStart) {
        record.shouldStart = true;
      }

      setActiveTerminal(workspaceState, terminalKey);
    },
    [setActiveTerminal],
  );

  const handleAddTerminal = useCallback(
    (workspacePath: string) => {
      const workspaceState = workspaceTabsRef.current.get(workspacePath);
      if (!workspaceState) return;
      const key = generateEphemeralKey(workspaceState);
      const label = generateEphemeralLabel(workspaceState);
      const record = setupTerminalRecord(workspaceState, {
        key,
        label,
        quickCommand: null,
        isEphemeral: true,
      });
      record.shouldStart = true;
      setActiveTerminal(workspaceState, key);
      forceRender();
    },
    [generateEphemeralKey, generateEphemeralLabel, setActiveTerminal, setupTerminalRecord],
  );

  const ensureWorkspaceTab = useCallback(
    async (workspace: WorkspaceSummary): Promise<WorkspaceTabState> => {
      const existing = workspaceTabsRef.current.get(workspace.path);
      if (existing) {
        existing.workspace = workspace;
        setActiveWorkspacePath(workspace.path);
        return existing;
      }

      let savedStateRaw: WorkspaceStateResponse | null = null;
      try {
        savedStateRaw = await window.terminalAPI.getWorkspaceState(workspace.path);
      } catch (error) {
        console.warn("Failed to fetch saved workspace terminals", error);
      }
      const savedState = ensureSavedWorkspaceState(workspace.path, savedStateRaw);

      const workspaceState: WorkspaceTabState = {
        workspace,
        terminalOrder: [],
        terminals: new Map(),
        activeTerminalKey: savedState.activeTerminal ?? null,
        savedState,
        ephemeralCounter: 1,
      };

      const baseDefinitions = defaultTerminalsRef.current.length
        ? defaultTerminalsRef.current
        : normaliseQuickAccessList([], { fallbackToDefault: true });
      baseDefinitions.forEach((definition) => {
        setupTerminalRecord(workspaceState, definition);
      });

      if (savedState.terminals) {
        Object.entries(savedState.terminals).forEach(([key, value]) => {
          if (workspaceState.terminals.has(key)) {
            const existingRecord = workspaceState.terminals.get(key);
            if (existingRecord && value?.label) {
              existingRecord.label = value.label;
            }
            return;
          }
          const label =
            value?.label && typeof value.label === "string" && value.label.trim()
              ? value.label.trim()
              : generateEphemeralLabel(workspaceState);
          setupTerminalRecord(workspaceState, {
            key,
            label,
            quickCommand: null,
            isEphemeral: true,
          });
        });
      }

      workspaceTabsRef.current.set(workspace.path, workspaceState);
      setWorkspaceOrder((prev) => [...prev, workspace.path]);
      setActiveWorkspacePath(workspace.path);
      forceRender();

      return workspaceState;
    },
    [generateEphemeralLabel, setupTerminalRecord],
  );

  const handleWorkspaceSelect = useCallback(
    async (workspace: WorkspaceSummary) => {
      if (workspace.kind === "folder") {
        return;
      }
      const state = await ensureWorkspaceTab(workspace);
      if (state.activeTerminalKey) {
        setActiveTerminal(state, state.activeTerminalKey);
      }
    },
    [ensureWorkspaceTab, setActiveTerminal],
  );

  const closeWorkspace = useCallback(
    (workspacePath: string, options: { preserveState?: boolean } = {}) => {
      const { preserveState = false } = options;
      const workspaceState = workspaceTabsRef.current.get(workspacePath);
      if (!workspaceState) {
        return;
      }

      workspaceState.terminals.forEach((record) => {
        disposeTerminalRuntime(workspacePath, record, preserveState || !record.isEphemeral);
      });

      if (!preserveState) {
        void window.terminalAPI
          .clearWorkspaceState(workspacePath)
          .catch((error) => console.warn("Failed to clear workspace terminal state", error));
      }

      workspaceTabsRef.current.delete(workspacePath);
      setWorkspaceOrder((prev) => prev.filter((path) => path !== workspacePath));

      if (activeWorkspacePath === workspacePath) {
        const next = workspaceOrder.find((path) => path !== workspacePath);
        setActiveWorkspacePath(next ?? null);
      }

      forceRender();
    },
    [activeWorkspacePath, disposeTerminalRuntime, workspaceOrder],
  );

  const handleEnvironmentChange = useCallback(
    async (name: string) => {
      if (!name || name === activeEnvironment) {
        return;
      }
      try {
        const response = await window.settingsAPI.setActiveEnvironment({ name });
        setEnvironments(response.environments);
        setActiveEnvironment(response.activeEnvironment);
        const normalized = normaliseQuickAccessList(response.quickAccess, { fallbackToDefault: true });
        defaultTerminalsRef.current = normalized;

        workspaceTabsRef.current.forEach((state, path) => {
          closeWorkspace(path, { preserveState: true });
        });
        workspaceTabsRef.current.clear();
        setWorkspaceOrder([]);
        setActiveWorkspacePath(null);
        pushToast(`Switched to ${name}`, "success");
        await loadWorkspaces();
      } catch (error) {
        console.error("Failed to switch environment", error);
        pushToast("Failed to switch environment", "error");
      }
    },
    [activeEnvironment, closeWorkspace, loadWorkspaces, pushToast],
  );

  const restoreWorkspacesFromStore = useCallback(
    async (workspaceList: WorkspaceSummary[]) => {
      let savedWorkspacePaths: string[] = [];
      try {
        const raw = await window.terminalAPI.listSavedWorkspaces();
        if (Array.isArray(raw)) {
          savedWorkspacePaths = raw.filter((entry): entry is string => typeof entry === "string");
        }
      } catch (error) {
        console.warn("Failed to restore workspace terminals", error);
      }
      if (!savedWorkspacePaths.length) {
        return;
      }
      for (const workspacePath of savedWorkspacePaths) {
        const workspace = workspaceList.find((item) => item.path === workspacePath);
        if (!workspace) continue;
        const state = await ensureWorkspaceTab(workspace);
        const savedState = state.savedState;
        Object.entries(savedState.terminals ?? {}).forEach(([key, terminalState]) => {
          const record = state.terminals.get(key);
          if (!record) {
            return;
          }
          if (typeof terminalState?.history === "string") {
            record.savedHistory = terminalState.history;
          }
          if (typeof terminalState?.quickCommandExecuted === "boolean") {
            record.quickCommandExecuted = terminalState.quickCommandExecuted;
          }
          record.lastExitCode = terminalState?.lastExitCode ?? record.lastExitCode;
          record.lastSignal = terminalState?.lastSignal ?? record.lastSignal;
          const shouldAutoLaunch =
            record.quickCommandExecuted || (record.savedHistory && record.savedHistory.length > 0);
          if (shouldAutoLaunch) {
            record.shouldStart = true;
          }
        });

        const targetActive =
          (savedState.activeTerminal && state.terminals.has(savedState.activeTerminal)
            ? savedState.activeTerminal
            : state.terminalOrder[0]) ?? null;
        if (targetActive) {
          setActiveTerminal(state, targetActive);
          const record = state.terminals.get(targetActive);
          if (record) {
            record.shouldStart = record.shouldStart || Boolean(record.quickCommand || record.savedHistory);
          }
        }
      }
      forceRender();
    },
    [ensureWorkspaceTab, setActiveTerminal],
  );

  const handleCreateWorkspace = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const branch = branchInput.trim();
      const baseRef = baseInput.trim();
      if (!branch) {
        pushToast("Branch name is required", "error");
        return;
      }
      setCreateInFlight(true);
      try {
        const workspace = await window.workspaceAPI.create({
          branch,
          baseRef: baseRef || undefined,
        });
        pushToast(`Workspace '${workspace.branch ?? workspace.relativePath}' ready`, "success");
        setBranchInput("");
        setBaseInput("");
        await loadWorkspaces();
        await handleWorkspaceSelect(workspace);
      } catch (error) {
        console.error("Failed to create workspace", error);
        pushToast("Failed to create workspace", "error");
      } finally {
        setCreateInFlight(false);
      }
    },
    [baseInput, branchInput, handleWorkspaceSelect, loadWorkspaces, pushToast],
  );

  const handleRefreshAll = useCallback(async () => {
    setRefreshing(true);
    try {
      await loadWorkspaces();
      pushToast("Workspace list refreshed", "success");
    } finally {
      setRefreshing(false);
    }
  }, [loadWorkspaces, pushToast]);

  const handleRefreshWorkspace = useCallback(
    async (workspace: WorkspaceSummary) => {
      try {
        const refreshed = await window.workspaceAPI.refresh({ path: workspace.path });
        setWorkspaces((prev) => prev.map((item) => (item.path === refreshed.path ? refreshed : item)));
        const state = workspaceTabsRef.current.get(workspace.path);
        if (state) {
          state.workspace = refreshed;
          forceRender();
        }
        pushToast("Workspace refreshed", "success");
      } catch (error) {
        console.error("Failed to refresh workspace", error);
        pushToast("Failed to refresh workspace", "error");
      }
    },
    [pushToast],
  );

  const handleDeleteWorkspace = useCallback(
    async (workspace: WorkspaceSummary) => {
      const confirmed = window.confirm(
        `Delete workspace '${workspace.branch ?? workspace.relativePath ?? workspace.path}'?`,
      );
      if (!confirmed) {
        return;
      }
      try {
        const result = await window.workspaceAPI.delete({ path: workspace.path });
        if (!result.success) {
          pushToast(result.message ?? "Failed to delete workspace", "error");
          return;
        }
        pushToast("Workspace deleted", "success");
        closeWorkspace(workspace.path);
        await loadWorkspaces();
      } catch (error) {
        console.error("Failed to delete workspace", error);
        pushToast("Failed to delete workspace", "error");
      }
    },
    [closeWorkspace, loadWorkspaces, pushToast],
  );

  useEffect(() => {
    void (async () => {
      await loadSettings();
      const list = await loadWorkspaces();
      await restoreWorkspacesFromStore(list);
    })();
  }, [loadSettings, loadWorkspaces, restoreWorkspacesFromStore]);

  useEffect(() => {
    const disposeData = window.terminalAPI.onData((payload: TerminalDataPayload) => {
      const meta = sessionIndexRef.current.get(payload.sessionId);
      if (!meta) return;
      const workspaceState = workspaceTabsRef.current.get(meta.workspacePath);
      if (!workspaceState) return;
      const record = workspaceState.terminals.get(meta.terminalKey);
      if (!record || record.closed) {
        if (record) {
          record.savedHistory = (record.savedHistory + payload.data).slice(-TERMINAL_HISTORY_LIMIT);
        }
        return;
      }
      const runtime = runtimeRef.current.get(runtimeKey(meta.workspacePath, meta.terminalKey));
      if (runtime) {
        runtime.terminal.write(payload.data);
      } else {
        record.savedHistory = (record.savedHistory + payload.data).slice(-TERMINAL_HISTORY_LIMIT);
      }
    });

    const disposeExit = window.terminalAPI.onExit((payload: TerminalExitPayload) => {
      const meta = sessionIndexRef.current.get(payload.sessionId);
      if (!meta) return;
      const workspaceState = workspaceTabsRef.current.get(meta.workspacePath);
      if (!workspaceState) return;
      const record = workspaceState.terminals.get(meta.terminalKey);
      if (!record || record.closed) return;
      record.closed = true;
      record.lastExitCode = payload.exitCode ?? null;
      record.lastSignal = payload.signal ?? null;
      const runtime = runtimeRef.current.get(runtimeKey(meta.workspacePath, meta.terminalKey));
      if (runtime) {
        runtime.terminal.write(
          `\r\n\x1b[38;5;110mProcess exited with code ${payload.exitCode ?? 0}${
            payload.signal ? ` (signal ${payload.signal})` : ""
          }\x1b[0m\r\n`,
        );
      }
      forceRender();
    });

    return () => {
      disposeData?.();
      disposeExit?.();
    };
  }, []);

  useEffect(() => {
    const handleResize = () => {
      if (!activeWorkspacePath) {
        return;
      }
      const workspaceState = workspaceTabsRef.current.get(activeWorkspacePath);
      if (!workspaceState || !workspaceState.activeTerminalKey) {
        return;
      }
      const record = workspaceState.terminals.get(workspaceState.activeTerminalKey);
      if (!record || record.closed) {
        return;
      }
      const runtime = runtimeRef.current.get(runtimeKey(activeWorkspacePath, workspaceState.activeTerminalKey));
      if (!runtime) return;
      runtime.fitAddon.fit();
      if (record.sessionId) {
        void window.terminalAPI
          .resize(record.sessionId, runtime.terminal.cols, runtime.terminal.rows)
          .catch((error) => console.warn("Failed to resize terminal", error));
      }
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [activeWorkspacePath, renderTicker]);

  const workspaceList = useMemo(
    () =>
      [...workspaces].sort((a, b) => {
        const aKey = a.branch || a.relativePath || a.path;
        const bKey = b.branch || b.relativePath || b.path;
        const branchCompare = aKey.localeCompare(bKey);
        if (branchCompare !== 0) return branchCompare;
        return a.path.localeCompare(b.path);
      }),
    [workspaces],
  );

  const activeWorkspaceState = activeWorkspacePath
    ? workspaceTabsRef.current.get(activeWorkspacePath) ?? null
    : null;

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="header-text">
          <h1>WTM (WorkTree Manager)</h1>
          <p>Manage git worktrees for your project repositories</p>
        </div>
        <div className="header-actions">
          <label className="environment-switcher">
            <span>Environment</span>
            <select
              id="environment-select"
              name="environment"
              value={activeEnvironment}
              onChange={(event) => handleEnvironmentChange(event.target.value)}
            >
              {Object.entries(environments).map(([name]) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <button
            id="refresh-button"
            className="accent-button"
            type="button"
            onClick={handleRefreshAll}
            disabled={refreshing}
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>

      <section className="create-section">
        <form id="create-form" autoComplete="off" onSubmit={handleCreateWorkspace}>
          <label className="field">
            <span>Branch or ticket name</span>
            <input
              id="branch-input"
              name="branch"
              type="text"
              placeholder="PROJ-1234-awesome-feature"
              value={branchInput}
              onChange={(event) => setBranchInput(event.target.value)}
              required
              disabled={createInFlight}
            />
          </label>
          <label className="field optional">
            <span>Base ref (optional)</span>
            <input
              id="base-input"
              name="base"
              type="text"
              placeholder="origin/develop"
              value={baseInput}
              onChange={(event) => setBaseInput(event.target.value)}
              disabled={createInFlight}
            />
          </label>
          <button id="create-button" className="primary-button" type="submit" disabled={createInFlight}>
            {createInFlight ? "Creating…" : "Create Workspace"}
          </button>
        </form>
        <p className="hint">
          New worktrees are created alongside your configured workspace root. Branch names are converted to folder
          friendly paths automatically.
        </p>
      </section>

      <main className="content-shell">
        <aside className="workspace-sidebar">
          <header className="workspace-sidebar-header">
            <h2>Workspaces</h2>
            <span>{loadingWorkspaces ? "Loading…" : `${workspaceList.length} found`}</span>
          </header>
          <div id="workspace-list" className="workspace-list">
            {loadingWorkspaces ? (
              <div className="empty-state">Loading workspaces…</div>
            ) : workspaceList.length === 0 ? (
              <div className="empty-state">No worktrees found. Create one to get started.</div>
            ) : (
              workspaceList.map((workspace) => {
                const isSelected = workspace.path === activeWorkspacePath;
                const statusIcons = buildStatusIcons(workspace);
                const branchLabel = workspace.branch || workspace.relativePath || "Detached HEAD";
                return (
                  <div
                    key={workspace.path}
                    className={cx("workspace-row", workspace.kind, { "is-active": isSelected })}
                    data-path={workspace.path}
                    title={buildStatusTooltip(workspace.status)}
                    onClick={(event) => {
                      const target = event.target as HTMLElement;
                      if (target.closest("button")) {
                        return;
                      }
                      void handleWorkspaceSelect(workspace);
                    }}
                  >
                    <div className="workspace-primary">
                      <span className="workspace-marker" />
                      <span className="workspace-name">{branchLabel}</span>
                    </div>
                    <div className="workspace-icons">
                      {statusIcons.map((icon, index) => (
                        <span key={`${icon.text}-${index}`} className={icon.className} title={icon.tooltip}>
                          {icon.text}
                        </span>
                      ))}
                    </div>
                    {workspace.kind === "worktree" && (
                      <div className="workspace-row-actions">
                        <button
                          className="row-icon-button"
                          type="button"
                          aria-label="Rescan workspace"
                          title="Rescan workspace"
                          onClick={(event) => {
                            event.stopPropagation();
                            void handleRefreshWorkspace(workspace);
                          }}
                        >
                          ⟳
                        </button>
                        <button
                          className="row-icon-button danger"
                          type="button"
                          aria-label="Delete workspace"
                          title="Delete workspace"
                          onClick={(event) => {
                            event.stopPropagation();
                            void handleDeleteWorkspace(workspace);
                          }}
                        >
                          ✖
                        </button>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </aside>

        <section id="workspace-tabs" className={cx("workspace-detail", { "is-empty": !activeWorkspaceState })}>
          <div className="workspace-tab-bar">
            {workspaceOrder.map((path) => {
              const state = workspaceTabsRef.current.get(path);
              if (!state) return null;
              const label = state.workspace.branch || state.workspace.relativePath || state.workspace.path;
              return (
                <button
                  key={path}
                  type="button"
                  className={cx("workspace-tab", { "is-active": activeWorkspacePath === path })}
                  onClick={() => setActiveWorkspacePath(path)}
                  title={`${label}\n${state.workspace.path}`}
                >
                  {label}
                </button>
              );
            })}
          </div>

          <div className="workspace-tab-panels">
            {!activeWorkspaceState ? (
              <div id="workspace-detail-placeholder" className="detail-placeholder">
                <h2>Workspace Details</h2>
                <p>Select a workspace from the list to open terminals and quick commands.</p>
              </div>
            ) : (
              workspaceOrder.map((path) => {
                const state = workspaceTabsRef.current.get(path);
                if (!state) return null;
                const isActive = path === activeWorkspacePath;
                const workspace = state.workspace;
                return (
                  <div
                    key={path}
                    className={cx("workspace-panel", { "is-active": isActive })}
                    data-path={workspace.path}
                  >
                    <header className="workspace-detail-header">
                      <div className="workspace-heading">
                        <div className="workspace-title-row">
                          <h2>{workspace.branch ?? workspace.relativePath ?? workspace.path}</h2>
                          <span
                            className="workspace-info-badge"
                            title={buildWorkspaceDetailTooltip(workspace)}
                            aria-label="Workspace status details"
                          >
                            ⓘ
                          </span>
                        </div>
                        <p className="workspace-path">{workspace.path}</p>
                      </div>
                      <div className="workspace-detail-actions">
                        <button
                          className="ghost-button"
                          type="button"
                          onClick={() => void handleRefreshWorkspace(workspace)}
                        >
                          Refresh
                        </button>
                        <button
                          className="danger-button"
                          type="button"
                          onClick={() => void handleDeleteWorkspace(workspace)}
                        >
                          Delete
                        </button>
                      </div>
                    </header>

                    <div className="terminal-tabs">
                      {state.terminalOrder.map((key) => {
                        const record = state.terminals.get(key);
                        if (!record) return null;
                        const active = state.activeTerminalKey === key;
                        return (
                          <div
                            key={key}
                            className={cx("terminal-tab", {
                              "is-active": active,
                              "is-exited": record.closed && !record.isEphemeral,
                              "is-ephemeral": record.isEphemeral,
                            })}
                            data-key={key}
                          >
                            <button
                              type="button"
                              className="terminal-tab-button"
                              onClick={() => handleTerminalTabClick(state.workspace.path, key)}
                            >
                              {record.label}
                            </button>
                            <button
                              type="button"
                              className="terminal-tab-close"
                              aria-label={`Close ${record.label}`}
                              onClick={() => handleTerminalClose(state.workspace.path, key)}
                            >
                              ×
                            </button>
                          </div>
                        );
                      })}
                      <button
                        type="button"
                        className="terminal-tab-add"
                        onClick={() => handleAddTerminal(state.workspace.path)}
                        aria-label="New terminal"
                        title="New terminal"
                      >
                        +
                      </button>
                    </div>

                    <div className="terminal-panels">
                      {state.activeTerminalKey
                        ? state.terminalOrder.map((key) => {
                            const record = state.terminals.get(key);
                            if (!record) return null;
                            const tabActive = state.activeTerminalKey === key;
                            return (
                              <TerminalPanel
                                key={key}
                                workspacePath={state.workspace.path}
                                record={record}
                                isActive={tabActive}
                                onStart={(workspacePath, targetRecord, container) => {
                                  const workspaceState = workspaceTabsRef.current.get(workspacePath);
                                  if (!workspaceState) return;
                                  void startTerminalSession(workspaceState, targetRecord, container);
                                }}
                                onDispose={(workspacePath, targetRecord) => {
                                  const workspaceState = workspaceTabsRef.current.get(workspacePath);
                                  if (!workspaceState) return;
                                  if (!workspaceState.terminals.has(targetRecord.key)) {
                                    disposeTerminalRuntime(workspacePath, targetRecord, !targetRecord.isEphemeral);
                                  }
                                }}
                              />
                            );
                          })
                        : (
                          <TerminalPlaceholder />
                          )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>
      </main>

      <div id="toast-container" className="toast-container">
        {toastList.map((toast) => (
          <div key={toast.id} className={cx("toast", toast.kind)}>
            {toast.message}
          </div>
        ))}
      </div>
    </div>
  );
}

export default App;
