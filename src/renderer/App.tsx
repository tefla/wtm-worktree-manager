import React, { FormEvent, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { AppHeader } from "./components/AppHeader";
import { CreateWorkspaceForm } from "./components/CreateWorkspaceForm";
import { WorkspaceSidebar } from "./components/WorkspaceSidebar";
import { WorkspaceTabsPanel } from "./components/WorkspaceTabsPanel";
import type {
  TerminalDefinition,
  SavedTerminalState,
  SavedWorkspaceState,
  TerminalRecord,
  WorkspaceTabState,
} from "./stateTypes";
import { cx } from "./utils/cx";
import type {
  EnsureTerminalResponse,
  ProjectState,
  QuickAccessEntry,
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

interface RecentProject {
  path: string;
  name: string;
}

const RECENT_PROJECTS_STORAGE_KEY = "wtm:recent-projects";

const TERMINAL_HISTORY_LIMIT = 40000;
const TERMINAL_FONT_FAMILY = '"JetBrains Mono", "Fira Code", "SFMono-Regular", monospace';
const TERMINAL_THEME = {
  background: "#070d1d",
  foreground: "#d1d5db",
  cursor: "#38bdf8",
  selectionBackground: "#1e293b",
};

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

function loadRecentProjectsFromStorage(): RecentProject[] {
  try {
    const raw = window.localStorage.getItem(RECENT_PROJECTS_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    const entries: RecentProject[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const path = typeof (item as RecentProject).path === "string" ? (item as RecentProject).path.trim() : "";
      if (!path) {
        continue;
      }
      const name = typeof (item as RecentProject).name === "string" ? (item as RecentProject).name.trim() : "";
      entries.push({ path, name: name || path });
    }
    return entries;
  } catch (error) {
    console.error("Failed to load recent projects", error);
    return [];
  }
}

function persistRecentProjects(projects: RecentProject[]): void {
  try {
    window.localStorage.setItem(
      RECENT_PROJECTS_STORAGE_KEY,
      JSON.stringify(projects.slice(0, 8)),
    );
  } catch (error) {
    console.error("Failed to persist recent projects", error);
  }
}

function upsertRecentProject(projects: RecentProject[], entry: RecentProject): RecentProject[] {
  const unique = projects.filter((item) => item.path !== entry.path);
  return [entry, ...unique].slice(0, 8);
}

function App(): JSX.Element {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [branchInput, setBranchInput] = useState("");
  const [baseInput, setBaseInput] = useState("");
  const [createInFlight, setCreateInFlight] = useState(false);
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);
  const [activeProjectPath, setActiveProjectPath] = useState<string | null>(null);
  const [activeProjectName, setActiveProjectName] = useState<string>("");
  const [openProjectsInNewWindow, setOpenProjectsInNewWindow] = useState(false);
  const defaultTerminalsRef = useRef<TerminalDefinition[]>([]);
  const [workspaceOrder, setWorkspaceOrder] = useState<string[]>([]);
  const [activeWorkspacePath, setActiveWorkspacePath] = useState<string | null>(null);
  const workspaceTabsRef = useRef<Map<string, WorkspaceTabState>>(new Map());
  const sessionIndexRef = useRef<Map<string, SessionIndexEntry>>(new Map());
  const runtimeRef = useRef<Map<string, TerminalRuntime>>(new Map());
  const previousProjectPathRef = useRef<string | null>(null);
  const [toastList, setToastList] = useState<Toast[]>([]);
  const toastIdRef = useRef(0);
  const [renderTicker, forceRender] = useReducer((value) => value + 1, 0);
  const [updatingWorkspaces, setUpdatingWorkspaces] = useState<Record<string, boolean>>({});

  const pushToast = useCallback((message: string, kind: ToastKind = "info") => {
    toastIdRef.current += 1;
    const id = toastIdRef.current;
    setToastList((prev) => [...prev, { id, kind, message }]);
    setTimeout(() => {
      setToastList((prev) => prev.filter((toast) => toast.id !== id));
    }, kind === "error" ? 5600 : 4200);
  }, []);

  const handleToggleNewWindow = useCallback((value: boolean) => {
    setOpenProjectsInNewWindow(value);
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
    if (!activeProjectPath) {
      setWorkspaces([]);
      setActiveWorkspacePath(null);
      setLoadingWorkspaces(false);
      return [];
    }
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
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("No project configured")) {
        // User has not selected a project yet; avoid spamming toasts.
        setWorkspaces([]);
        setActiveWorkspacePath(null);
      } else {
        console.error("Failed to load workspaces", error);
        pushToast("Failed to load workspaces", "error");
      }
    } finally {
      setLoadingWorkspaces(false);
    }
    return list;
  }, [activeProjectPath, pushToast, reopenWorkspaceTab]);

  const applyProjectState = useCallback(
    (state: ProjectState, options: { persistRecent?: boolean } = {}) => {
      const { persistRecent = true } = options;
      const normalizedQuickAccess = normaliseQuickAccessList(state.quickAccess, { fallbackToDefault: true });
      defaultTerminalsRef.current = normalizedQuickAccess;
      setActiveProjectName(state.projectName);
      setActiveProjectPath((current) => (current === state.projectPath ? current : state.projectPath));
      if (persistRecent) {
        setRecentProjects((current) => {
          const updated = upsertRecentProject(current, { path: state.projectPath, name: state.projectName });
          persistRecentProjects(updated);
          return updated;
        });
      }
    },
    [],
  );

  const openProjectByPath = useCallback(
    async (path: string, options: { silent?: boolean; openInNewWindow?: boolean } = {}) => {
      const { silent = false, openInNewWindow = false } = options;
      const trimmed = path.trim();
      if (!trimmed) {
        return;
      }
      try {
        const state = await window.projectAPI.openPath({ path: trimmed, openInNewWindow });
        if (openInNewWindow) {
          if (state) {
            setRecentProjects((current) => {
              const updated = upsertRecentProject(current, {
                path: state.projectPath,
                name: state.projectName,
              });
              persistRecentProjects(updated);
              return updated;
            });
            if (!silent) {
              pushToast(`Project opened in new window: ${state.projectName}`, "success");
            }
          }
          return;
        }
        if (!state) {
          return;
        }
        applyProjectState(state);
        if (!silent) {
          pushToast(`Project opened: ${state.projectName}`, "success");
        }
      } catch (error) {
        console.error("Failed to open project", error);
        pushToast("Failed to open project", "error");
      }
    },
    [applyProjectState, pushToast],
  );

  const openProjectWithDialog = useCallback(async (options: { openInNewWindow?: boolean } = {}) => {
    const { openInNewWindow = false } = options;
    try {
      const state = await window.projectAPI.openDialog({ openInNewWindow });
      if (openInNewWindow) {
        if (state) {
          setRecentProjects((current) => {
            const updated = upsertRecentProject(current, {
              path: state.projectPath,
              name: state.projectName,
            });
            persistRecentProjects(updated);
            return updated;
          });
          pushToast(`Project opened in new window: ${state.projectName}`, "success");
        }
        return;
      }
      if (!state) {
        return;
      }
      applyProjectState(state);
      pushToast(`Project opened: ${state.projectName}`, "success");
    } catch (error) {
      console.error("Failed to open project via dialog", error);
      pushToast("Failed to open project", "error");
    }
  }, [applyProjectState, pushToast]);

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
    (workspacePath: string, record: TerminalRecord, preserveSession = false) => {
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

  const clearAllWorkspaces = useCallback(() => {
    workspaceTabsRef.current.forEach((state, path) => {
      state.terminals.forEach((record) => {
        disposeTerminalRuntime(path, record, true);
      });
    });
    workspaceTabsRef.current.clear();
    sessionIndexRef.current.clear();
    runtimeRef.current.clear();
    setWorkspaceOrder([]);
    setActiveWorkspacePath(null);
    setWorkspaces([]);
    setUpdatingWorkspaces({});
  }, [disposeTerminalRuntime]);

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

  const handleTerminalStart = useCallback(
    (workspacePath: string, record: TerminalRecord, container: HTMLDivElement) => {
      const workspaceState = workspaceTabsRef.current.get(workspacePath);
      if (!workspaceState) {
        return;
      }
      void startTerminalSession(workspaceState, record, container);
    },
    [startTerminalSession],
  );

  const handleTerminalDispose = useCallback(
    (workspacePath: string, record: TerminalRecord) => {
      const workspaceState = workspaceTabsRef.current.get(workspacePath);
      if (!workspaceState) {
        return;
      }
      if (!workspaceState.terminals.has(record.key)) {
        disposeTerminalRuntime(workspacePath, record, !record.isEphemeral);
      }
    },
    [disposeTerminalRuntime],
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

  const handleWorkspaceTabSelect = useCallback(
    (workspacePath: string) => {
      setActiveWorkspacePath(workspacePath);
      const state = workspaceTabsRef.current.get(workspacePath);
      if (state && state.activeTerminalKey) {
        setActiveTerminal(state, state.activeTerminalKey);
      }
    },
    [setActiveTerminal],
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

  const handleProjectSelect = useCallback(
    (path: string) => {
      const trimmed = path.trim();
      if (!trimmed) {
        return;
      }
      const sameAsActive = trimmed === activeProjectPath;
      if (!openProjectsInNewWindow && sameAsActive) {
        return;
      }
      void openProjectByPath(trimmed, { openInNewWindow: openProjectsInNewWindow });
    },
    [activeProjectPath, openProjectByPath, openProjectsInNewWindow],
  );

  const handleOpenProjectDialog = useCallback(() => {
    void openProjectWithDialog({ openInNewWindow: openProjectsInNewWindow });
  }, [openProjectWithDialog, openProjectsInNewWindow]);

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
      if (!activeProjectPath) {
        pushToast("Open a project before creating workspaces", "error");
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
    [activeProjectPath, baseInput, branchInput, handleWorkspaceSelect, loadWorkspaces, pushToast],
  );

  const handleRefreshAll = useCallback(async () => {
    setRefreshing(true);
    try {
      if (!activeProjectPath) {
        pushToast("Open a project first", "info");
        return;
      }
      await loadWorkspaces();
      pushToast("Workspace list refreshed", "success");
    } finally {
      setRefreshing(false);
    }
  }, [activeProjectPath, loadWorkspaces, pushToast]);

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

  const handleUpdateWorkspace = useCallback(
    async (workspace: WorkspaceSummary) => {
      setUpdatingWorkspaces((prev) => ({ ...prev, [workspace.path]: true }));
      try {
        const updated = await window.workspaceAPI.update({ path: workspace.path });
        setWorkspaces((prev) => prev.map((item) => (item.path === updated.path ? updated : item)));
        const state = workspaceTabsRef.current.get(workspace.path);
        if (state) {
          state.workspace = updated;
          forceRender();
        }
        pushToast(`Workspace '${updated.branch ?? updated.relativePath}' is up to date`, "success");
      } catch (error) {
        console.error("Failed to update workspace", error);
        const message = error instanceof Error ? error.message : "Failed to update workspace";
        pushToast(message, "error");
      } finally {
        setUpdatingWorkspaces((prev) => {
          const next = { ...prev };
          delete next[workspace.path];
          return next;
        });
      }
    },
    [forceRender, pushToast],
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
    const stored = loadRecentProjectsFromStorage();
    setRecentProjects(stored);
    void (async () => {
      try {
        const current = await window.projectAPI.getCurrent();
        if (current) {
          applyProjectState(current, { persistRecent: true });
          return;
        }
        if (stored.length > 0) {
          await openProjectByPath(stored[0].path, { silent: true });
        }
      } catch (error) {
        console.error("Failed to initialise project", error);
      }
    })();
  }, [applyProjectState, openProjectByPath]);

  useEffect(() => {
    if (previousProjectPathRef.current && previousProjectPathRef.current !== activeProjectPath) {
      clearAllWorkspaces();
    }
    previousProjectPathRef.current = activeProjectPath;
  }, [activeProjectPath, clearAllWorkspaces]);

  useEffect(() => {
    if (!activeProjectPath) {
      return;
    }
    void (async () => {
      const list = await loadWorkspaces();
      await restoreWorkspacesFromStore(list);
    })();
  }, [activeProjectPath, loadWorkspaces, restoreWorkspacesFromStore]);

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

  const headerProjects = useMemo(
    () =>
      recentProjects.map((project) => ({
        path: project.path,
        label: project.name && project.name !== project.path ? `${project.name} (${project.path})` : project.path,
      })),
    [recentProjects],
  );

  const headerSubtitle = activeProjectPath
    ? `Project: ${activeProjectName || activeProjectPath}`
    : "Open a project to manage its worktrees";

  return (
    <div className="app-shell">
      <AppHeader
        title="WTM (WorkTree Manager)"
        subtitle={headerSubtitle}
        recentProjects={headerProjects}
        activeProjectPath={activeProjectPath}
        refreshing={refreshing}
        onSelectProject={handleProjectSelect}
        onOpenProject={handleOpenProjectDialog}
        onRefreshAll={handleRefreshAll}
        openProjectsInNewWindow={openProjectsInNewWindow}
        onToggleNewWindow={handleToggleNewWindow}
      />

      <CreateWorkspaceForm
        branchInput={branchInput}
        baseInput={baseInput}
        createInFlight={createInFlight}
        disabled={!activeProjectPath}
        onBranchChange={setBranchInput}
        onBaseChange={setBaseInput}
        onSubmit={handleCreateWorkspace}
      />

      <main className="content-shell">
        <WorkspaceSidebar
          loading={loadingWorkspaces}
          workspaces={workspaceList}
          activeWorkspacePath={activeWorkspacePath}
          onSelect={handleWorkspaceSelect}
          onRefreshWorkspace={handleRefreshWorkspace}
          onDeleteWorkspace={handleDeleteWorkspace}
          onUpdateWorkspace={handleUpdateWorkspace}
          updatingPaths={updatingWorkspaces}
        />
        <WorkspaceTabsPanel
          workspaceOrder={workspaceOrder}
          workspaceTabs={workspaceTabsRef.current}
          activeWorkspacePath={activeWorkspacePath}
          onSelectWorkspace={handleWorkspaceTabSelect}
          onRefreshWorkspace={handleRefreshWorkspace}
          onDeleteWorkspace={handleDeleteWorkspace}
          onAddTerminal={handleAddTerminal}
          onTerminalTabClick={handleTerminalTabClick}
          onTerminalClose={handleTerminalClose}
          onTerminalStart={handleTerminalStart}
          onTerminalDispose={handleTerminalDispose}
        />
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
