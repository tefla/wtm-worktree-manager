import React, { FormEvent, useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { AppHeader } from "./components/AppHeader";
import { WorkspaceSidebar } from "./components/WorkspaceSidebar";
import { WorkspaceTabsPanel } from "./components/WorkspaceTabsPanel";
import { SettingsOverlay } from "./components/SettingsOverlay";
import type { BranchSuggestion } from "./components/CreateWorkspaceForm";
import type {
  TerminalDefinition,
  SavedTerminalState,
  SavedWorkspaceState,
  TerminalRecord,
  WorkspaceTabState,
  QuickAccessDraft,
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
import { buildWorkspaceBranchName } from "../shared/jira";
import type { JiraTicketSummary } from "../shared/jira";
import type { ToastKind } from "./store/types";
import {
  setWorkspaces,
  setWorkspaceOrder,
  setActiveWorkspacePath,
  setUpdatingWorkspaces,
  setLoadingWorkspaces,
  setRefreshing,
  setBranchInput,
  setBaseInput,
  setCreateInFlight,
  setBranchCatalog,
  resetWorkspaces,
  selectWorkspaceState,
} from "./store/slices/workspacesSlice";
import {
  setActiveProjectName,
  setActiveProjectIcon,
  setActiveProjectPath,
  removeRecentProject,
  addRecentProject,
  setComposeProjectName,
  setComposeServices,
  setComposeError,
  setComposeLoading,
  setOpenProjectsInNewWindow,
  setComposeSnapshot,
  selectProjectState,
} from "./store/slices/projectSlice";
import { setJiraTickets, selectJiraState } from "./store/slices/jiraSlice";
import { addToast, removeToast, selectNotificationsState } from "./store/slices/notificationsSlice";
import { useAppDispatch, useAppSelector } from "./store/hooks";
import { normaliseComposeServices, normaliseQuickAccessList } from "./services/normalisers";
import { jiraAPI, projectAPI, terminalAPI, workspaceAPI, wtmEnv } from "./services/ipc";
import { useQuickAccessSettings } from "./hooks/useQuickAccessSettings";
import { useWidgets, useWorkspaceRowActions } from "./widgets/registry";
import type { WidgetRenderContext } from "./widgets/types";

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
const MAX_BRANCH_SUGGESTIONS = 8;

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

function App(): JSX.Element {
  const dispatch = useAppDispatch();
  const {
    list: workspaces,
    loading: loadingWorkspaces,
    refreshing,
    branchInput,
    baseInput,
    createInFlight,
    branchCatalog,
    order: workspaceOrder,
    activePath: activeWorkspacePath,
    updating: updatingWorkspaces,
  } = useAppSelector(selectWorkspaceState);
  const {
    recentProjects,
    activeProjectPath,
    activeProjectName,
    activeProjectIcon,
    composeProjectName,
    composeServices,
    composeError,
    composeLoading,
    openProjectsInNewWindow,
  } = useAppSelector(selectProjectState);
  const { tickets: jiraTickets } = useAppSelector(selectJiraState);
  const { toasts: toastList } = useAppSelector(selectNotificationsState);
  const autoBaseRefRef = useRef<string | null>(null);
  const defaultTerminalsRef = useRef<TerminalDefinition[]>([]);
  const workspaceTabsRef = useRef<Map<string, WorkspaceTabState>>(new Map());
  const sessionIndexRef = useRef<Map<string, SessionIndexEntry>>(new Map());
  const runtimeRef = useRef<Map<string, TerminalRuntime>>(new Map());
  const previousProjectPathRef = useRef<string | null>(null);
  const toastIdRef = useRef(0);
  const activeWorkspacePathRef = useRef(activeWorkspacePath);
  const [renderTicker, forceRender] = useReducer((value) => value + 1, 0);
  const workspacesRef = useRef(workspaces);
  const workspaceOrderRef = useRef(workspaceOrder);
  const updatingWorkspacesRef = useRef(updatingWorkspaces);
  const initialisedRef = useRef(false);

  useEffect(() => {
    workspacesRef.current = workspaces;
  }, [workspaces]);

  useEffect(() => {
    workspaceOrderRef.current = workspaceOrder;
  }, [workspaceOrder]);

  useEffect(() => {
    activeWorkspacePathRef.current = activeWorkspacePath;
  }, [activeWorkspacePath]);

  useEffect(() => {
    updatingWorkspacesRef.current = updatingWorkspaces;
  }, [updatingWorkspaces]);

  const pushToast = useCallback((message: string, kind: ToastKind = "info") => {
    toastIdRef.current += 1;
    const id = toastIdRef.current;
    dispatch(addToast({ id, kind, message }));
    setTimeout(() => {
      dispatch(removeToast(id));
    }, kind === "error" ? 5600 : 4200);
  }, [dispatch]);

  const handleToggleNewWindow = useCallback((value: boolean) => {
    dispatch(setOpenProjectsInNewWindow(value));
  }, [dispatch]);

  const refreshComposeServices = useCallback(async () => {
    if (!activeProjectPath) {
      dispatch(setComposeServices([]));
      dispatch(setComposeProjectName(null));
      dispatch(setComposeError(null));
      dispatch(setComposeLoading(false));
      return;
    }
    dispatch(setComposeLoading(true));
    try {
      const snapshot = await projectAPI.listComposeServices();
      dispatch(setComposeServices(normaliseComposeServices(snapshot?.services)));
      const projectLabel =
        typeof snapshot?.projectName === "string" && snapshot.projectName.trim()
          ? snapshot.projectName
          : activeProjectName || null;
      dispatch(setComposeProjectName(projectLabel));
      dispatch(setComposeError(typeof snapshot?.error === "string" && snapshot.error ? snapshot.error : null));
    } catch (error) {
      console.error("Failed to load docker compose services", error);
      dispatch(setComposeError("Failed to load docker compose services"));
    } finally {
      dispatch(setComposeLoading(false));
    }
  }, [activeProjectName, activeProjectPath, dispatch]);

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
      workspacesRef.current = [];
      dispatch(setWorkspaces([]));
      dispatch(setActiveWorkspacePath(null));
      dispatch(setLoadingWorkspaces(false));
      return [];
    }
    dispatch(setLoadingWorkspaces(true));
    let list: WorkspaceSummary[] = [];
    try {
      list = await workspaceAPI.list();
      workspacesRef.current = list;
      dispatch(setWorkspaces(list));
      list.forEach((workspace) => reopenWorkspaceTab(workspace));
      const previousActivePath = activeWorkspacePathRef.current;
      const nextActive =
        list.length === 0
          ? null
          : previousActivePath && list.some((item) => item.path === previousActivePath)
            ? previousActivePath
            : list[0].path;
      dispatch(setActiveWorkspacePath(nextActive));
      activeWorkspacePathRef.current = nextActive;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("No project configured")) {
        // User has not selected a project yet; avoid spamming toasts.
        workspacesRef.current = [];
        dispatch(setWorkspaces([]));
        dispatch(setActiveWorkspacePath(null));
      } else {
        console.error("Failed to load workspaces", error);
        pushToast("Failed to load workspaces", "error");
      }
    } finally {
      dispatch(setLoadingWorkspaces(false));
    }
    return list;
  }, [activeProjectPath, dispatch, pushToast, reopenWorkspaceTab]);

  const loadBranches = useCallback(async () => {
    if (!activeProjectPath) {
      dispatch(setBranchCatalog({ local: [], remote: [] }));
      return;
    }
    try {
      const response = await workspaceAPI.listBranches();
      const payload =
        response && typeof response === "object"
          ? (response as { local?: unknown; remote?: unknown })
          : { local: undefined, remote: undefined };
      const normalizeList = (value: unknown) =>
        Array.isArray(value)
          ? value
              .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
              .filter((entry): entry is string => Boolean(entry))
          : [];
      dispatch(
        setBranchCatalog({
          local: normalizeList(payload.local),
          remote: normalizeList(payload.remote),
        }),
      );
    } catch (error) {
      console.warn("Failed to load branch catalog", error);
      dispatch(setBranchCatalog({ local: [], remote: [] }));
    }
  }, [activeProjectPath, dispatch]);

  const loadJiraTickets = useCallback(
    async (options: { forceRefresh?: boolean } = {}) => {
      try {
        const response = await jiraAPI.listTickets(options);
        if (!Array.isArray(response)) {
          dispatch(setJiraTickets([]));
          return;
        }
        const seenKeys = new Set<string>();
        const normalized: JiraTicketSummary[] = [];
        for (const ticket of response) {
          if (!ticket || typeof ticket.key !== "string" || typeof ticket.summary !== "string") {
            continue;
          }
          const key = ticket.key.toUpperCase();
          const summary = ticket.summary.trim();
          if (!summary || seenKeys.has(key)) {
            continue;
          }
          seenKeys.add(key);
          normalized.push({
            key,
            summary,
            ...(typeof ticket.url === "string" && ticket.url ? { url: ticket.url } : {}),
          });
        }
        normalized.sort((a, b) => a.key.localeCompare(b.key));
        dispatch(setJiraTickets(normalized));
      } catch (error) {
        console.warn("Failed to load Jira ticket cache", error);
      }
    },
    [dispatch],
  );

  const applyProjectState = useCallback(
    (state: ProjectState, options: { persistRecent?: boolean } = {}) => {
      const { persistRecent = true } = options;
      const normalizedQuickAccess = normaliseQuickAccessList(state.quickAccess, { fallbackToDefault: true });
      defaultTerminalsRef.current = normalizedQuickAccess;
      dispatch(setActiveProjectName(state.projectName));
      dispatch(setActiveProjectIcon(state.projectIcon ?? null));
      dispatch(setComposeProjectName(state.composeProjectName ?? null));
      dispatch(setComposeServices(normaliseComposeServices(state.composeServices)));
      dispatch(setComposeError(state.composeError ?? null));
      dispatch(setComposeLoading(false));
      if (activeProjectPath !== state.projectPath) {
        dispatch(setActiveProjectPath(state.projectPath));
      }
      if (persistRecent) {
        dispatch(
          addRecentProject({
            path: state.projectPath,
            name: state.projectName,
            icon: state.projectIcon ?? null,
          }),
        );
      }
    },
    [activeProjectPath, dispatch],
  );

  const openProjectByPath = useCallback(
    async (path: string, options: { silent?: boolean; openInNewWindow?: boolean } = {}) => {
      const { silent = false, openInNewWindow = false } = options;
      const trimmed = path.trim();
      if (!trimmed) {
        return;
      }
      try {
        const state = await projectAPI.openPath({ path: trimmed, openInNewWindow });
        if (openInNewWindow) {
          if (state) {
            dispatch(
              addRecentProject({
                path: state.projectPath,
                name: state.projectName,
                icon: state.projectIcon ?? null,
              }),
            );
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
    [applyProjectState, dispatch, pushToast],
  );

  const openProjectWithDialog = useCallback(async (options: { openInNewWindow?: boolean } = {}) => {
    const { openInNewWindow = false } = options;
    try {
      const state = await projectAPI.openDialog({ openInNewWindow });
      if (openInNewWindow) {
        if (state) {
          dispatch(
            addRecentProject({
              path: state.projectPath,
              name: state.projectName,
              icon: state.projectIcon ?? null,
            }),
          );
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
  }, [applyProjectState, dispatch, pushToast]);

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
        if (preserveSession) {
          void terminalAPI
            .release(record.sessionId)
            .catch((error) => console.warn("Failed to release terminal session", error));
        } else {
          void terminalAPI
            .dispose(record.sessionId, { preserve: preserveSession })
            .catch((error) => console.warn("Failed to dispose terminal", error));
        }
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
    workspaceOrderRef.current = [];
    workspacesRef.current = [];
    updatingWorkspacesRef.current = {};
    dispatch(setWorkspaceOrder([]));
    dispatch(setActiveWorkspacePath(null));
    dispatch(setWorkspaces([]));
    dispatch(setUpdatingWorkspaces({}));
  }, [dispatch, disposeTerminalRuntime]);

  const setActiveTerminal = useCallback(
    (workspaceState: WorkspaceTabState, terminalKey: string | null) => {
      workspaceState.activeTerminalKey = terminalKey;
      forceRender();
      void terminalAPI
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

  const syncWorkspaceQuickAccess = useCallback(
    (entries: QuickAccessEntry[]) => {
      const definitions = normaliseQuickAccessList(entries, { fallbackToDefault: true });
      defaultTerminalsRef.current = definitions;
      const desiredKeys = new Set(definitions.map((definition) => definition.key));

      workspaceTabsRef.current.forEach((workspaceState) => {
        const workspacePath = workspaceState.workspace.path;

        const removalKeys: string[] = [];
        workspaceState.terminals.forEach((record, key) => {
          if (!desiredKeys.has(key) && !record.isEphemeral) {
            removalKeys.push(key);
          }
        });

        removalKeys.forEach((targetKey) => {
          const record = workspaceState.terminals.get(targetKey);
          if (!record) {
            return;
          }
          const wasActive = workspaceState.activeTerminalKey === targetKey;
          disposeTerminalRuntime(workspacePath, record, false);
          workspaceState.terminals.delete(targetKey);
          workspaceState.terminalOrder = workspaceState.terminalOrder.filter((existingKey) => existingKey !== targetKey);
          if (workspaceState.savedState.terminals) {
            delete workspaceState.savedState.terminals[targetKey];
          }
          if (wasActive) {
            const fallback = workspaceState.terminalOrder.length ? workspaceState.terminalOrder[0] : null;
            setActiveTerminal(workspaceState, fallback);
          }
        });

        definitions.forEach((definition) => {
          setupTerminalRecord(workspaceState, definition);
        });

        const preserved = workspaceState.terminalOrder.filter((key) => !desiredKeys.has(key));
        workspaceState.terminalOrder = [
          ...definitions.map((definition) => definition.key),
          ...preserved,
        ];

        if (workspaceState.activeTerminalKey && !workspaceState.terminalOrder.includes(workspaceState.activeTerminalKey)) {
          const fallback = workspaceState.terminalOrder.length ? workspaceState.terminalOrder[0] : null;
          setActiveTerminal(workspaceState, fallback);
        }
      });

      forceRender();
    },
    [disposeTerminalRuntime, setActiveTerminal, setupTerminalRecord, forceRender],
  );

  const {
    settingsOpen,
    settingsDraft,
    settingsSaving,
    settingsError,
    settingsIcon,
    openSettingsOverlay,
    closeSettingsOverlay,
    updateSettingsEntry,
    removeSettingsEntry,
    moveSettingsEntry,
    addSettingsEntry,
    handleSettingsSave,
    handleSettingsIconChange,
  } = useQuickAccessSettings({
    defaultTerminalsRef,
    applyProjectState,
    syncWorkspaceQuickAccess,
    pushToast,
    activeProjectIcon,
  });

  useEffect(() => {
    if (!settingsOpen) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeSettingsOverlay();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [settingsOpen, closeSettingsOverlay]);

  const startTerminalSession = useCallback(
    async (workspaceState: WorkspaceTabState, record: TerminalRecord, container: HTMLDivElement) => {
      const key = runtimeKey(workspaceState.workspace.path, record.key);
      const existingRuntime = runtimeRef.current.get(key);
      if (existingRuntime && record.sessionId && !record.closed) {
        if (existingRuntime.container !== container) {
          existingRuntime.resizeObserver.disconnect();
          while (container.firstChild) {
            container.removeChild(container.firstChild);
          }
          const previousContainer = existingRuntime.container;
          while (previousContainer.firstChild) {
            container.appendChild(previousContainer.firstChild);
          }
          const resizeObserver = new ResizeObserver(() => {
            existingRuntime.fitAddon.fit();
            if (record.sessionId && !record.closed) {
              void terminalAPI
                .resize(record.sessionId, existingRuntime.terminal.cols, existingRuntime.terminal.rows)
                .catch((error) => console.warn("Failed to resize terminal", error));
            }
          });
          resizeObserver.observe(container);
          existingRuntime.container = container;
          existingRuntime.resizeObserver = resizeObserver;
          runtimeRef.current.set(key, existingRuntime);
          requestAnimationFrame(() => {
            existingRuntime.fitAddon.fit();
            if (record.sessionId && !record.closed) {
              if (workspaceState.activeTerminalKey === record.key) {
                existingRuntime.terminal.focus();
              }
              void terminalAPI
                .resize(record.sessionId, existingRuntime.terminal.cols, existingRuntime.terminal.rows)
                .catch((error) => console.warn("Failed to resize terminal", error));
            }
          });
        }
        record.shouldStart = false;
        record.closed = false;
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
        sessionInfo = await terminalAPI.ensureSession({
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
          terminalAPI.write(record.sessionId, data);
        }
      });

      const resizeObserver = new ResizeObserver(() => {
        fitAddon.fit();
        if (record.sessionId && !record.closed) {
          void terminalAPI
            .resize(record.sessionId, terminal.cols, terminal.rows)
            .catch((error) => console.warn("Failed to resize terminal", error));
        }
      });
      resizeObserver.observe(container);

      runtimeRef.current.set(key, { terminal, fitAddon, resizeObserver, container });

      void terminalAPI.resize(sessionInfo.sessionId, terminal.cols, terminal.rows).catch((error) => {
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
          terminalAPI.write(record.sessionId, `${record.quickCommand}\n`);
          record.quickCommandExecuted = true;
          void terminalAPI
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
        dispatch(setActiveWorkspacePath(workspace.path));
        return existing;
      }

      let savedStateRaw: WorkspaceStateResponse | null = null;
      try {
        savedStateRaw = await terminalAPI.getWorkspaceState(workspace.path);
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
      const currentOrder = workspaceOrderRef.current;
      const nextOrder = [...currentOrder, workspace.path];
      workspaceOrderRef.current = nextOrder;
      dispatch(setWorkspaceOrder(nextOrder));
      dispatch(setActiveWorkspacePath(workspace.path));
      forceRender();

      return workspaceState;
    },
    [dispatch, generateEphemeralLabel, setupTerminalRecord],
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
      dispatch(setActiveWorkspacePath(workspacePath));
      const state = workspaceTabsRef.current.get(workspacePath);
      if (state && state.activeTerminalKey) {
        setActiveTerminal(state, state.activeTerminalKey);
      }
    },
    [dispatch, setActiveTerminal],
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
        void terminalAPI
          .clearWorkspaceState(workspacePath)
          .catch((error) => console.warn("Failed to clear workspace terminal state", error));
      }

      workspaceTabsRef.current.delete(workspacePath);
      const filteredOrder = workspaceOrderRef.current.filter((path) => path !== workspacePath);
      workspaceOrderRef.current = filteredOrder;
      dispatch(setWorkspaceOrder(filteredOrder));

      if (activeWorkspacePath === workspacePath) {
        dispatch(setActiveWorkspacePath(filteredOrder[0] ?? null));
      }

      forceRender();
    },
    [activeWorkspacePath, dispatch, disposeTerminalRuntime],
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

  const handleRemoveRecentProject = useCallback(
    (path: string) => {
      const trimmed = path.trim();
      if (!trimmed) {
        return;
      }
      dispatch(removeRecentProject(trimmed));
    },
    [dispatch],
  );

  const handleOpenProjectDialog = useCallback(() => {
    void openProjectWithDialog({ openInNewWindow: openProjectsInNewWindow });
  }, [openProjectWithDialog, openProjectsInNewWindow]);

  const restoreWorkspacesFromStore = useCallback(
    async (workspaceList: WorkspaceSummary[]) => {
      let savedWorkspacePaths: string[] = [];
      try {
        const raw = await terminalAPI.listSavedWorkspaces();
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
      dispatch(setCreateInFlight(true));
      try {
        const workspace = await workspaceAPI.create({
          branch,
          baseRef: baseRef || undefined,
        });
        pushToast(`Workspace '${workspace.branch ?? workspace.relativePath}' ready`, "success");
        dispatch(setBranchInput(""));
        dispatch(setBaseInput(""));
        autoBaseRefRef.current = null;
        await loadWorkspaces();
        await loadBranches();
        await handleWorkspaceSelect(workspace);
      } catch (error) {
        console.error("Failed to create workspace", error);
        pushToast("Failed to create workspace", "error");
      } finally {
        dispatch(setCreateInFlight(false));
      }
    },
    [
      activeProjectPath,
      baseInput,
      branchInput,
      dispatch,
      handleWorkspaceSelect,
      loadBranches,
      loadWorkspaces,
      pushToast,
    ],
  );

  const handleRefreshAll = useCallback(async () => {
    dispatch(setRefreshing(true));
    try {
      if (!activeProjectPath) {
        pushToast("Open a project first", "info");
        return;
      }
      await loadWorkspaces();
      await loadBranches();
      await loadJiraTickets({ forceRefresh: true });
      await refreshComposeServices();
      pushToast("Workspace list refreshed", "success");
    } finally {
      dispatch(setRefreshing(false));
    }
  }, [activeProjectPath, dispatch, loadBranches, loadJiraTickets, loadWorkspaces, pushToast, refreshComposeServices]);

  const handleRefreshWorkspace = useCallback(
    async (workspace: WorkspaceSummary) => {
      try {
        const refreshed = await workspaceAPI.refresh({ path: workspace.path });
        const current = workspacesRef.current;
        const next = current.map((item) => (item.path === refreshed.path ? refreshed : item));
        workspacesRef.current = next;
        dispatch(setWorkspaces(next));
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
    [dispatch, forceRender, pushToast],
  );

  const handleUpdateWorkspace = useCallback(
    async (workspace: WorkspaceSummary) => {
      const queued = { ...updatingWorkspacesRef.current, [workspace.path]: true };
      updatingWorkspacesRef.current = queued;
      dispatch(setUpdatingWorkspaces(queued));
      try {
        const updated = await workspaceAPI.update({ path: workspace.path });
        const current = workspacesRef.current;
        const next = current.map((item) => (item.path === updated.path ? updated : item));
        workspacesRef.current = next;
        dispatch(setWorkspaces(next));
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
        const current = { ...updatingWorkspacesRef.current };
        delete current[workspace.path];
        updatingWorkspacesRef.current = current;
        dispatch(setUpdatingWorkspaces(current));
      }
    },
    [dispatch, forceRender, pushToast],
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
        const result = await workspaceAPI.delete({ path: workspace.path });
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
    if (initialisedRef.current) {
      return;
    }
    initialisedRef.current = true;
    const stored = recentProjects;
    void (async () => {
      try {
        const current = await projectAPI.getCurrent();
        if (current) {
          applyProjectState(current, { persistRecent: true });
          return;
        }
        const automationProjectPath = wtmEnv.getE2EProjectPath() ?? undefined;
        if (automationProjectPath) {
          await openProjectByPath(automationProjectPath, { silent: true });
          return;
        }
        if (stored.length > 0) {
          await openProjectByPath(stored[0].path, { silent: true });
        }
      } catch (error) {
        console.error("Failed to initialise project", error);
      }
    })();
  }, [applyProjectState, openProjectByPath, recentProjects]);

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
    if (!activeProjectPath) {
      return;
    }
    void refreshComposeServices();
    const interval = window.setInterval(() => {
      void refreshComposeServices();
    }, 30000);
    return () => {
      window.clearInterval(interval);
    };
  }, [activeProjectPath, refreshComposeServices]);

  useEffect(() => {
    if (!activeProjectPath) {
      dispatch(setBranchCatalog({ local: [], remote: [] }));
      dispatch(setJiraTickets([]));
      dispatch(setComposeServices([]));
      dispatch(setComposeProjectName(null));
      dispatch(setComposeError(null));
      dispatch(setComposeLoading(false));
      return;
    }
    void loadBranches();
    void loadJiraTickets();
  }, [activeProjectPath, dispatch, loadBranches, loadJiraTickets]);

  useEffect(() => {
    const disposeData = terminalAPI.onData((payload: TerminalDataPayload) => {
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

    const disposeExit = terminalAPI.onExit((payload: TerminalExitPayload) => {
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
        void terminalAPI
          .resize(record.sessionId, runtime.terminal.cols, runtime.terminal.rows)
          .catch((error) => console.warn("Failed to resize terminal", error));
      }
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [activeWorkspacePath, renderTicker]);

  const branchSuggestions = useMemo<BranchSuggestion[]>(() => {
    const query = branchInput.trim().toLowerCase();
    if (!query) {
      return [];
    }

    const SOURCE_BASE_PRIORITY: Record<BranchSuggestion["source"], number> = {
      workspace: 0,
      local: 10,
      remote: 20,
      jira: 30,
    };

    const evaluateMatch = (terms: string[]): number | null => {
      if (!terms.length) {
        return null;
      }
      for (const term of terms) {
        if (term.startsWith(query)) {
          return 0;
        }
      }
      for (const term of terms) {
        if (term.includes(query)) {
          return 1;
        }
      }
      return null;
    };

    const reservedBranchNames = new Set<string>();
    const localBranchNames = new Set<string>();
    const candidates: Array<{ suggestion: BranchSuggestion; priority: number }> = [];
    const seenIds = new Set<string>();

    const pushCandidate = (suggestion: BranchSuggestion, terms: string[]) => {
      if (seenIds.has(suggestion.id)) {
        return;
      }
      const normalizedTerms = terms.map((term) => term.toLowerCase());
      const match = evaluateMatch(normalizedTerms);
      if (match === null) {
        return;
      }
      const basePriority = SOURCE_BASE_PRIORITY[suggestion.source];
      candidates.push({ suggestion, priority: basePriority + match });
      seenIds.add(suggestion.id);
    };

    workspaces.forEach((workspace) => {
      if (workspace.kind !== "worktree") {
        return;
      }
      const branchName = workspace.branch?.trim() ?? "";
      const relativePath = workspace.relativePath?.trim() ?? "";
      const value = branchName || relativePath;
      if (!value) {
        return;
      }
      const lowerBranch = branchName.toLowerCase();
      const lowerRelative = relativePath.toLowerCase();
      if (branchName) {
        reservedBranchNames.add(lowerBranch);
      }
      if (relativePath) {
        reservedBranchNames.add(lowerRelative);
      }
      const terms = [value.toLowerCase()];
      if (branchName && branchName !== value) {
        terms.push(lowerBranch);
      }
      if (relativePath && relativePath !== value) {
        terms.push(lowerRelative);
      }
      pushCandidate(
        {
          id: `workspace:${workspace.path}`,
          value,
          label: `Workspace • ${value}`,
          source: "workspace",
        },
        terms,
      );
    });

    branchCatalog.local.forEach((entry) => {
      const name = entry.trim();
      if (!name) {
        return;
      }
      const lower = name.toLowerCase();
      localBranchNames.add(lower);
      if (reservedBranchNames.has(lower)) {
        return;
      }
      reservedBranchNames.add(lower);
      pushCandidate(
        {
          id: `local:${name}`,
          value: name,
          label: `Local branch • ${name}`,
          source: "local",
        },
        [lower],
      );
    });

    branchCatalog.remote.forEach((entry) => {
      const ref = entry.trim();
      if (!ref) {
        return;
      }
      const slashIndex = ref.indexOf("/");
      if (slashIndex <= 0 || slashIndex === ref.length - 1) {
        return;
      }
      const branchName = ref.slice(slashIndex + 1);
      if (!branchName) {
        return;
      }
      const lowerBranch = branchName.toLowerCase();
      if (reservedBranchNames.has(lowerBranch) || localBranchNames.has(lowerBranch)) {
        return;
      }
      reservedBranchNames.add(lowerBranch);
      pushCandidate(
        {
          id: `remote:${ref}`,
          value: branchName,
          label: `Remote branch • ${ref} (create ${branchName})`,
          source: "remote",
          baseRef: ref,
        },
        [lowerBranch, ref.toLowerCase()],
      );
    });

    jiraTickets.forEach((ticket) => {
      const branchName = buildWorkspaceBranchName(ticket);
      if (!branchName) {
        return;
      }
      const lowerBranch = branchName.toLowerCase();
      if (reservedBranchNames.has(lowerBranch)) {
        return;
      }
      pushCandidate(
        {
          id: `jira:${ticket.key}`,
          value: branchName,
          label: `Ticket • ${ticket.key}: ${ticket.summary}`,
          source: "jira",
        },
        [ticket.key.toLowerCase(), lowerBranch, ticket.summary.toLowerCase()],
      );
    });

    candidates.sort((a, b) => {
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }
      return a.suggestion.label.localeCompare(b.suggestion.label);
    });

    return candidates.slice(0, MAX_BRANCH_SUGGESTIONS).map((entry) => entry.suggestion);
  }, [branchCatalog, branchInput, jiraTickets, workspaces]);

  const handleBranchChange = useCallback(
    (value: string) => {
      dispatch(setBranchInput(value));
      if (!value) {
        if (autoBaseRefRef.current) {
          if (baseInput === autoBaseRefRef.current) {
            dispatch(setBaseInput(""));
          }
          autoBaseRefRef.current = null;
        }
        return;
      }
      const match = branchSuggestions.find((suggestion) => suggestion.value === value);
      if (match?.baseRef) {
        autoBaseRefRef.current = match.baseRef;
        if (baseInput !== match.baseRef) {
          dispatch(setBaseInput(match.baseRef));
        }
      } else if (autoBaseRefRef.current) {
        if (baseInput === autoBaseRefRef.current) {
          dispatch(setBaseInput(""));
        }
        autoBaseRefRef.current = null;
      }
    },
    [baseInput, branchSuggestions, dispatch],
  );

  const handleBaseChange = useCallback((value: string) => {
    autoBaseRefRef.current = null;
    dispatch(setBaseInput(value));
  }, [dispatch]);

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
        icon: project.icon ?? null,
      })),
    [recentProjects],
  );

  const headerSubtitle = activeProjectPath
    ? `Project: ${activeProjectIcon ? `${activeProjectIcon} ` : ""}${activeProjectName || activeProjectPath}`
    : "Open a project to manage its worktrees";

  const composePanelProjectName = (composeProjectName ?? activeProjectName) || null;

  const workspaceRowActions = useWorkspaceRowActions();

  const widgetContext = useMemo<WidgetRenderContext>(() => ({
    workspace: {
      list: workspaceList,
      order: workspaceOrder,
      activePath: activeWorkspacePath,
      updating: updatingWorkspaces,
      loading: loadingWorkspaces,
      tabs: workspaceTabsRef.current,
    },
    compose: {
      hasActiveProject: Boolean(activeProjectPath),
      projectName: composePanelProjectName,
      services: composeServices,
      loading: composeLoading,
      error: composeError,
      refresh: refreshComposeServices,
    },
    project: {
      activePath: activeProjectPath,
      activeName: activeProjectName,
      activeIcon: activeProjectIcon,
      recentProjects,
    },
    workspaceRowActions,
    callbacks: {
      selectWorkspace: handleWorkspaceSelect,
      refreshWorkspace: handleRefreshWorkspace,
      deleteWorkspace: handleDeleteWorkspace,
      updateWorkspace: handleUpdateWorkspace,
      selectWorkspaceTab: handleWorkspaceTabSelect,
      addTerminal: handleAddTerminal,
      onTerminalTabClick: handleTerminalTabClick,
      onTerminalClose: handleTerminalClose,
      onTerminalStart: handleTerminalStart,
      onTerminalDispose: handleTerminalDispose,
    },
  }), [
    workspaceList,
    workspaceOrder,
    activeWorkspacePath,
    updatingWorkspaces,
    loadingWorkspaces,
    activeProjectPath,
    composePanelProjectName,
    composeServices,
    composeLoading,
    composeError,
    refreshComposeServices,
    activeProjectName,
    recentProjects,
    workspaceRowActions,
    handleWorkspaceSelect,
    handleRefreshWorkspace,
    handleDeleteWorkspace,
    handleUpdateWorkspace,
    handleWorkspaceTabSelect,
    handleAddTerminal,
    handleTerminalTabClick,
    handleTerminalClose,
    handleTerminalStart,
    handleTerminalDispose,
    renderTicker,
  ]);

  const sidebarWidgets = useWidgets("sidebar");
  const mainWidgets = useWidgets("main");
  const auxiliaryWidgets = useWidgets("aux");

  return (
    <div className="app-shell">
      <AppHeader
        title="WTM (WorkTree Manager)"
        subtitle={headerSubtitle}
        recentProjects={headerProjects}
        activeProjectPath={activeProjectPath}
        refreshing={refreshing}
        onSelectProject={handleProjectSelect}
        onRemoveProject={handleRemoveRecentProject}
        onOpenProject={handleOpenProjectDialog}
        onRefreshAll={handleRefreshAll}
        createWorkspace={{
          branchInput,
          baseInput,
          createInFlight,
          disabled: !activeProjectPath,
          onBranchChange: handleBranchChange,
          onBaseChange: handleBaseChange,
          onSubmit: handleCreateWorkspace,
          branchSuggestions,
        }}
        openProjectsInNewWindow={openProjectsInNewWindow}
        onToggleNewWindow={handleToggleNewWindow}
        onOpenSettings={openSettingsOverlay}
        settingsDisabled={!activeProjectPath}
      />

      <main className="content-shell">
        {sidebarWidgets.map((widget) => (
          <React.Fragment key={widget.id}>{widget.render(widgetContext)}</React.Fragment>
        ))}
        {mainWidgets.map((widget) => (
          <React.Fragment key={widget.id}>{widget.render(widgetContext)}</React.Fragment>
        ))}
        {auxiliaryWidgets.map((widget) => (
          <React.Fragment key={widget.id}>{widget.render(widgetContext)}</React.Fragment>
        ))}
      </main>

      {settingsOpen ? (
        <SettingsOverlay
          icon={settingsIcon}
          quickAccess={settingsDraft}
          saving={settingsSaving}
          error={settingsError}
          onRequestClose={closeSettingsOverlay}
          onSubmit={handleSettingsSave}
          onIconChange={handleSettingsIconChange}
          onEntryAdd={addSettingsEntry}
          onEntryChange={updateSettingsEntry}
          onEntryRemove={removeSettingsEntry}
          onEntryMove={moveSettingsEntry}
        />
      ) : null}

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
