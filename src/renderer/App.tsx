import React, { FormEvent, useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { AppHeader } from "./components/AppHeader";
import { WorkspaceSidebar } from "./components/WorkspaceSidebar";
import { WorkspaceTabsPanel } from "./components/WorkspaceTabsPanel";
import { ComposeServicesPanel } from "./components/ComposeServicesPanel";
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
  ProjectConfig,
} from "./types";
import { buildWorkspaceBranchName } from "../shared/jira";
import type { JiraTicketSummary } from "../shared/jira";
import type { DockerComposeServiceInfo } from "../shared/dockerCompose";
import type { ToastKind } from "./store/appSlice";
import {
  addRecentProject,
  addToast,
  removeToast,
  selectAppState,
  setActiveProjectName,
  setActiveProjectPath,
  setActiveWorkspacePath,
  setBaseInput,
  setBranchCatalog,
  setBranchInput,
  setComposeError,
  setComposeLoading,
  setComposeProjectName,
  setComposeServices,
  setCreateInFlight,
  setJiraTickets,
  setLoadingWorkspaces,
  setOpenProjectsInNewWindow,
  setRefreshing,
  setSettingsDraft,
  setSettingsError,
  setSettingsOpen,
  setSettingsSaving,
  setUpdatingWorkspaces,
  setWorkspaces,
  setWorkspaceOrder,
} from "./store/appSlice";
import { useAppDispatch, useAppSelector } from "./store/hooks";

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

function normaliseComposeServices(list: unknown): DockerComposeServiceInfo[] {
  if (!Array.isArray(list)) {
    return [];
  }
  const normalized: DockerComposeServiceInfo[] = [];
  list.forEach((entry) => {
    if (!entry || typeof entry !== "object") {
      return;
    }
    const candidate = entry as Partial<DockerComposeServiceInfo>;
    if (typeof candidate.serviceName !== "string") {
      return;
    }
    const service: DockerComposeServiceInfo = {
      serviceName: candidate.serviceName,
      containerName:
        typeof candidate.containerName === "string" && candidate.containerName.trim()
          ? candidate.containerName
          : null,
      projectName:
        typeof candidate.projectName === "string" && candidate.projectName.trim()
          ? candidate.projectName
          : "",
      state: typeof candidate.state === "string" && candidate.state.trim() ? candidate.state : "unknown",
      status:
        typeof candidate.status === "string" && candidate.status.trim()
          ? candidate.status
          : typeof candidate.state === "string" && candidate.state.trim()
            ? candidate.state
            : "unknown",
      ...(typeof candidate.id === "string" && candidate.id.trim() ? { id: candidate.id } : {}),
      ...(typeof candidate.health === "string" && candidate.health.trim()
        ? { health: candidate.health }
        : {}),
    };
    normalized.push(service);
  });
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

function App(): JSX.Element {
  const dispatch = useAppDispatch();
  const {
    workspaces,
    loadingWorkspaces,
    refreshing,
    branchInput,
    baseInput,
    createInFlight,
    jiraTickets,
    branchCatalog,
    recentProjects,
    activeProjectPath,
    activeProjectName,
    composeProjectName,
    composeServices,
    composeError,
    composeLoading,
    openProjectsInNewWindow,
    workspaceOrder,
    activeWorkspacePath,
    updatingWorkspaces,
    settingsOpen,
    settingsDraft,
    settingsSaving,
    settingsError,
    toastList,
  } = useAppSelector(selectAppState);
  const autoBaseRefRef = useRef<string | null>(null);
  const defaultTerminalsRef = useRef<TerminalDefinition[]>([]);
  const workspaceTabsRef = useRef<Map<string, WorkspaceTabState>>(new Map());
  const sessionIndexRef = useRef<Map<string, SessionIndexEntry>>(new Map());
  const runtimeRef = useRef<Map<string, TerminalRuntime>>(new Map());
  const previousProjectPathRef = useRef<string | null>(null);
  const toastIdRef = useRef(0);
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

  const openSettingsOverlay = useCallback(() => {
    const baseDefinitions = defaultTerminalsRef.current.length
      ? defaultTerminalsRef.current
      : normaliseQuickAccessList([], { fallbackToDefault: true });
    dispatch(
      setSettingsDraft(
        baseDefinitions.map((definition) => ({
          id: definition.key,
          initialKey: definition.key,
          label: definition.label,
          quickCommand: definition.quickCommand ?? "",
        })),
      ),
    );
    dispatch(setSettingsError(null));
    dispatch(setSettingsOpen(true));
  }, [dispatch]);

  const closeSettingsOverlay = useCallback(() => {
    if (settingsSaving) {
      return;
    }
    dispatch(setSettingsOpen(false));
    dispatch(setSettingsError(null));
  }, [dispatch, settingsSaving]);

  const updateSettingsEntry = useCallback(
    (id: string, patch: Partial<Pick<QuickAccessDraft, "label" | "quickCommand">>) => {
      dispatch(
        setSettingsDraft(
          settingsDraft.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)),
        ),
      );
    },
    [dispatch, settingsDraft],
  );

  const removeSettingsEntry = useCallback((id: string) => {
    dispatch(setSettingsDraft(settingsDraft.filter((entry) => entry.id !== id)));
  }, [dispatch, settingsDraft]);

  const moveSettingsEntry = useCallback((id: string, direction: "up" | "down") => {
    const index = settingsDraft.findIndex((entry) => entry.id === id);
    if (index === -1) {
      return;
    }
    const targetIndex = direction === "up" ? Math.max(0, index - 1) : Math.min(settingsDraft.length - 1, index + 1);
    if (targetIndex === index) {
      return;
    }
    const next = [...settingsDraft];
    const [item] = next.splice(index, 1);
    next.splice(targetIndex, 0, item);
    dispatch(setSettingsDraft(next));
  }, [dispatch, settingsDraft]);

  const addSettingsEntry = useCallback(() => {
    const id = `quick-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    dispatch(
      setSettingsDraft([
        ...settingsDraft,
        {
          id,
          initialKey: null,
          label: "",
          quickCommand: "",
        },
      ]),
    );
  }, [dispatch, settingsDraft]);

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
      const snapshot = await window.projectAPI.listComposeServices();
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
      list = await window.workspaceAPI.list();
      workspacesRef.current = list;
      dispatch(setWorkspaces(list));
      list.forEach((workspace) => reopenWorkspaceTab(workspace));
      const nextActive =
        list.length === 0
          ? null
          : activeWorkspacePath && list.some((item) => item.path === activeWorkspacePath)
            ? activeWorkspacePath
            : list[0].path;
      dispatch(setActiveWorkspacePath(nextActive));
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
  }, [activeProjectPath, activeWorkspacePath, dispatch, pushToast, reopenWorkspaceTab]);

  const loadBranches = useCallback(async () => {
    if (!activeProjectPath || !window.workspaceAPI?.listBranches) {
      dispatch(setBranchCatalog({ local: [], remote: [] }));
      return;
    }
    try {
      const response = await window.workspaceAPI.listBranches();
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
      if (!window.jiraAPI?.listTickets) {
        dispatch(setJiraTickets([]));
        return;
      }
      try {
        const response = await window.jiraAPI.listTickets(options);
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
      dispatch(setComposeProjectName(state.composeProjectName ?? null));
      dispatch(setComposeServices(normaliseComposeServices(state.composeServices)));
      dispatch(setComposeError(state.composeError ?? null));
      dispatch(setComposeLoading(false));
      if (activeProjectPath !== state.projectPath) {
        dispatch(setActiveProjectPath(state.projectPath));
      }
      if (persistRecent) {
        dispatch(addRecentProject({ path: state.projectPath, name: state.projectName }));
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
        const state = await window.projectAPI.openPath({ path: trimmed, openInNewWindow });
        if (openInNewWindow) {
          if (state) {
            dispatch(addRecentProject({ path: state.projectPath, name: state.projectName }));
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
      const state = await window.projectAPI.openDialog({ openInNewWindow });
      if (openInNewWindow) {
        if (state) {
          dispatch(addRecentProject({ path: state.projectPath, name: state.projectName }));
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
          void window.terminalAPI
            .release(record.sessionId)
            .catch((error) => console.warn("Failed to release terminal session", error));
        } else {
          void window.terminalAPI
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

  const handleSettingsSave = useCallback(async () => {
    if (settingsSaving) {
      return;
    }
    if (!window.projectAPI?.updateConfig) {
      dispatch(setSettingsError("Settings are not available in this build."));
      return;
    }
    dispatch(setSettingsError(null));

    const trimmed = settingsDraft.map((entry) => ({
      ...entry,
      label: entry.label.trim(),
      quickCommand: entry.quickCommand.trim(),
    }));

    if (trimmed.length === 0) {
      dispatch(setSettingsError("Add at least one quick access command before saving."));
      return;
    }

    const missingCommand = trimmed.some((entry) => !entry.quickCommand);
    if (missingCommand) {
      dispatch(setSettingsError("Each quick access entry needs a command."));
      return;
    }

    const usedKeys = new Set<string>();
    const quickAccess: QuickAccessEntry[] = [];

    trimmed.forEach((entry, index) => {
      const fallbackLabel = entry.label || entry.quickCommand;
      const slugBase = slugify(fallbackLabel);
      const preferredBase =
        entry.initialKey && entry.initialKey.trim() ? entry.initialKey.trim() : slugBase || `slot-${index + 1}`;
      let candidate = preferredBase || `slot-${index + 1}`;
      let counter = 2;
      while (usedKeys.has(candidate)) {
        const suffixBase =
          entry.initialKey && entry.initialKey.trim() ? entry.initialKey.trim() : slugBase || preferredBase || `slot-${index + 1}`;
        candidate = `${suffixBase}-${counter}`;
        counter += 1;
      }
      usedKeys.add(candidate);
      quickAccess.push({
        key: candidate,
        label: fallbackLabel,
        quickCommand: entry.quickCommand,
      });
    });

    const config: ProjectConfig = { quickAccess };
    dispatch(setSettingsSaving(true));
    try {
      const state = await window.projectAPI.updateConfig({ config });
      applyProjectState(state, { persistRecent: false });
      syncWorkspaceQuickAccess(state.quickAccess);
      dispatch(setSettingsError(null));
      dispatch(setSettingsOpen(false));
      pushToast("Settings updated", "success");
    } catch (error) {
      console.error("Failed to update project settings", error);
      dispatch(setSettingsError("Failed to save settings. Please try again."));
    } finally {
      dispatch(setSettingsSaving(false));
    }
  }, [dispatch, settingsSaving, settingsDraft, applyProjectState, syncWorkspaceQuickAccess, pushToast]);

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
        dispatch(setActiveWorkspacePath(workspace.path));
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
        void window.terminalAPI
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
      dispatch(setCreateInFlight(true));
      try {
        const workspace = await window.workspaceAPI.create({
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
        const refreshed = await window.workspaceAPI.refresh({ path: workspace.path });
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
        const updated = await window.workspaceAPI.update({ path: workspace.path });
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
    if (initialisedRef.current) {
      return;
    }
    initialisedRef.current = true;
    const stored = recentProjects;
    void (async () => {
      try {
        const current = await window.projectAPI.getCurrent();
        if (current) {
          applyProjectState(current, { persistRecent: true });
          return;
        }
        const automationProjectPath = window.wtmEnv?.e2eProjectPath ?? undefined;
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
      })),
    [recentProjects],
  );

  const headerSubtitle = activeProjectPath
    ? `Project: ${activeProjectName || activeProjectPath}`
    : "Open a project to manage its worktrees";

  const composePanelProjectName = (composeProjectName ?? activeProjectName) || null;

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
        <ComposeServicesPanel
          hasActiveProject={Boolean(activeProjectPath)}
          projectName={composePanelProjectName}
          services={composeServices}
          loading={composeLoading}
          error={composeError}
          onRefresh={refreshComposeServices}
        />
      </main>

      {settingsOpen ? (
        <SettingsOverlay
          quickAccess={settingsDraft}
          saving={settingsSaving}
          error={settingsError}
          onRequestClose={closeSettingsOverlay}
          onSubmit={handleSettingsSave}
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
