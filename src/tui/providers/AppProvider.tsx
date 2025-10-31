import React, { createContext, useContext, useState, useCallback, useEffect, useMemo } from "react";
import type { WorkspaceSummary } from "../../shared/ipc";
import type { WorkspaceManager } from "../../core/workspaceManager";
import { slugify, shortName, displayWorkspaceName } from "../lib/strings";
import { PtyManager, type PtyDataEvent } from "../services/ptyManager";

type Mode = "loading" | "ready" | "creating-workspace" | "busy";

const MAIN_TAB_ID = "main";

interface TabDescriptor {
  id: string;
  label: string;
}

interface WorkspaceDescriptor {
  id: string;
  label: string;
  path: string;
}

interface DescriptorMap {
  [workspaceId: string]: WorkspaceDescriptor;
}

function buildDescriptor(workspace: WorkspaceSummary): WorkspaceDescriptor {
  const label = displayWorkspaceName(workspace);
  const baseId = workspace.id || label || workspace.path;
  const slug = slugify(baseId) || slugify(label) || slugify(shortName(workspace.path)) || "workspace";
  return {
    id: slug,
    label,
    path: workspace.path,
  };
}

interface AppState {
  mode: Mode;
  status: string | null;
  error: string | null;
  workspaces: WorkspaceSummary[];
  descriptorMap: DescriptorMap;
  selectedWorkspaceId: string | null;
  tabsByWorkspace: Record<string, TabDescriptor[]>;
  selectedTabByWorkspace: Record<string, string>;
  inputBuffer: string;
  showHelp: boolean;
  terminalFocused: boolean;
  terminalOutput: string[];
}

interface AppActions {
  moveWorkspaceSelection: (direction: 1 | -1) => void;
  cycleTab: (direction: 1 | -1) => void;
  toggleTerminalFocus: () => void;
  handleCreateTab: () => Promise<void>;
  startCreateWorkspace: () => void;
  cancelCreateWorkspace: () => void;
  submitCreateWorkspace: () => Promise<void>;
  refreshWorkspaces: (focusWorkspaceId?: string) => Promise<void>;
  setInputBuffer: React.Dispatch<React.SetStateAction<string>>;
  toggleHelp: () => void;
  sendKeysToTerminal: (keys: string) => void;
}

interface AppContextValue {
  state: AppState;
  actions: AppActions;
  currentWorkspace: WorkspaceSummary | null;
  currentTabs: TabDescriptor[];
  selectedTabId: string | null;
}

const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error("useApp must be used within AppProvider");
  }
  return context;
}

interface AppProviderProps {
  workspaceManager: WorkspaceManager;
  children: React.ReactNode;
}

export const AppProvider: React.FC<AppProviderProps> = ({ workspaceManager, children }) => {
  const [mode, setMode] = useState<Mode>("loading");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [descriptorMap, setDescriptorMap] = useState<DescriptorMap>({});
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [tabsByWorkspace, setTabsByWorkspace] = useState<Record<string, TabDescriptor[]>>({});
  const [selectedTabByWorkspace, setSelectedTabByWorkspace] = useState<Record<string, string>>({});
  const [inputBuffer, setInputBuffer] = useState<string>("");
  const [showHelp, setShowHelp] = useState<boolean>(false);
  const [terminalFocused, setTerminalFocused] = useState<boolean>(false);
  const [terminalOutput, setTerminalOutput] = useState<string[]>([]);

  const ptyManagerRef = React.useRef<PtyManager | null>(null);

  const currentWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null,
    [selectedWorkspaceId, workspaces],
  );

  const currentTabs = useMemo(() => {
    if (!currentWorkspace) return [] as TabDescriptor[];
    return tabsByWorkspace[currentWorkspace.id] ?? [];
  }, [currentWorkspace, tabsByWorkspace]);

  const selectedTabId = useMemo(() => {
    if (!currentWorkspace) {
      return null;
    }
    const stored = selectedTabByWorkspace[currentWorkspace.id];
    if (stored) return stored;
    const fallback = currentTabs[0]?.id ?? MAIN_TAB_ID;
    return fallback;
  }, [currentWorkspace, currentTabs, selectedTabByWorkspace]);

  // Initialize workspaces and create default tabs
  const refreshWorkspaces = useCallback(
    async (focusWorkspaceId?: string) => {
      const list = await workspaceManager.listWorkspaces();
      setWorkspaces(list);
      const descriptors: DescriptorMap = {};
      list.forEach((workspace) => {
        descriptors[workspace.id] = buildDescriptor(workspace);
      });
      setDescriptorMap(descriptors);

      if (list.length === 0) {
        setSelectedWorkspaceId(null);
        setTabsByWorkspace({});
        setSelectedTabByWorkspace({});
        return;
      }

      // Initialize tabs for workspaces if needed
      const newTabsByWorkspace: Record<string, TabDescriptor[]> = { ...tabsByWorkspace };
      const newSelectedTabs: Record<string, string> = { ...selectedTabByWorkspace };

      for (const workspace of list) {
        if (!newTabsByWorkspace[workspace.id]) {
          newTabsByWorkspace[workspace.id] = [{ id: MAIN_TAB_ID, label: "main" }];
          newSelectedTabs[workspace.id] = MAIN_TAB_ID;
        }
      }

      setTabsByWorkspace(newTabsByWorkspace);
      setSelectedTabByWorkspace(newSelectedTabs);

      const fallbackId =
        (focusWorkspaceId && list.some((workspace) => workspace.id === focusWorkspaceId))
          ? focusWorkspaceId
          : selectedWorkspaceId && list.some((workspace) => workspace.id === selectedWorkspaceId)
            ? selectedWorkspaceId
            : list[0].id;
      setSelectedWorkspaceId(fallbackId);
    },
    [selectedWorkspaceId, tabsByWorkspace, selectedTabByWorkspace, workspaceManager],
  );

  // Bootstrap on mount
  useEffect(() => {
    let cancelled = false;
    const bootstrap = async () => {
      setMode("loading");
      setStatus("Initializing...");

      // Initialize PtyManager
      const ptyManager = new PtyManager();
      ptyManagerRef.current = ptyManager;

      setStatus("Loading workspaces...");
      const list = await workspaceManager.listWorkspaces();
      if (cancelled) return;
      setStatus(`Found ${list.length} workspaces`);

      setWorkspaces(list);
      const descriptors: DescriptorMap = {};
      const newTabsByWorkspace: Record<string, TabDescriptor[]> = {};
      const newSelectedTabs: Record<string, string> = {};

      list.forEach((workspace) => {
        descriptors[workspace.id] = buildDescriptor(workspace);
        newTabsByWorkspace[workspace.id] = [{ id: MAIN_TAB_ID, label: "main" }];
        newSelectedTabs[workspace.id] = MAIN_TAB_ID;
      });

      setDescriptorMap(descriptors);
      setTabsByWorkspace(newTabsByWorkspace);
      setSelectedTabByWorkspace(newSelectedTabs);

      if (list.length > 0) {
        setSelectedWorkspaceId(list[0].id);
      }

      if (!cancelled) {
        setMode("ready");
        setStatus(null);
      }
    };

    void bootstrap().catch((err) => {
      if (!cancelled) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        setError(`Bootstrap error: ${errorMsg}`);
        setStatus(null);
        setMode("ready");
      }
    });

    return () => {
      cancelled = true;
      // Cleanup all ptys
      ptyManagerRef.current?.killAll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only run once on mount

  // Listen for pty data events
  useEffect(() => {
    const ptyManager = ptyManagerRef.current;
    if (!ptyManager || !currentWorkspace || mode !== "ready") {
      return;
    }

    const descriptor = descriptorMap[currentWorkspace.id];
    const tabId = selectedTabByWorkspace[currentWorkspace.id];
    if (!descriptor || !tabId) {
      return;
    }

    // Ensure pty exists for current tab
    if (!ptyManager.hasPty(currentWorkspace.id, tabId)) {
      ptyManager.createPty({
        workspaceId: currentWorkspace.id,
        tabId,
        label: tabId,
        path: descriptor.path,
      });
    }

    // Get current buffer
    const buffer = ptyManager.getBuffer(currentWorkspace.id, tabId);
    setTerminalOutput(buffer);

    // Listen for new data
    const handleData = (event: PtyDataEvent) => {
      if (event.workspaceId === currentWorkspace.id && event.tabId === tabId) {
        const updatedBuffer = ptyManager.getBuffer(currentWorkspace.id, tabId);
        setTerminalOutput(updatedBuffer);
      }
    };

    ptyManager.on("data", handleData);

    return () => {
      ptyManager.off("data", handleData);
    };
  }, [currentWorkspace, descriptorMap, selectedTabByWorkspace, mode]);

  const moveWorkspaceSelection = useCallback(
    (direction: 1 | -1) => {
      if (workspaces.length === 0) {
        return;
      }
      const currentIndex = selectedWorkspaceId
        ? workspaces.findIndex((workspace) => workspace.id === selectedWorkspaceId)
        : 0;
      const nextIndex = Math.min(workspaces.length - 1, Math.max(0, currentIndex + direction));
      const nextWorkspace = workspaces[nextIndex];
      if (!nextWorkspace) {
        return;
      }
      setSelectedWorkspaceId(nextWorkspace.id);
    },
    [selectedWorkspaceId, workspaces],
  );

  const cycleTab = useCallback(
    (direction: 1 | -1) => {
      if (!currentWorkspace) return;
      const tabs = tabsByWorkspace[currentWorkspace.id] ?? [];
      if (tabs.length === 0) return;
      const currentTab = selectedTabByWorkspace[currentWorkspace.id] ?? tabs[0].id;
      const currentIndex = tabs.findIndex((tab) => tab.id === currentTab);
      const nextIndex = (currentIndex + direction + tabs.length) % tabs.length;
      const nextTab = tabs[nextIndex];
      if (nextTab) {
        setSelectedTabByWorkspace((prev) => ({ ...prev, [currentWorkspace.id]: nextTab.id }));
      }
    },
    [currentWorkspace, selectedTabByWorkspace, tabsByWorkspace],
  );

  const toggleTerminalFocus = useCallback(() => {
    setTerminalFocused((prev) => !prev);
  }, []);

  const sendKeysToTerminal = useCallback(
    (keys: string) => {
      if (!currentWorkspace) return;
      const tabId = selectedTabByWorkspace[currentWorkspace.id] ?? MAIN_TAB_ID;
      const ptyManager = ptyManagerRef.current;
      if (!ptyManager) return;

      // Translate key names to actual terminal control sequences
      let translated: string;
      switch (keys) {
        case "Enter":
          translated = "\r";
          break;
        case "BSpace":
          translated = "\x7f";
          break;
        case "Tab":
          translated = "\t";
          break;
        case "Up":
          translated = "\x1b[A";
          break;
        case "Down":
          translated = "\x1b[B";
          break;
        case "Left":
          translated = "\x1b[D";
          break;
        case "Right":
          translated = "\x1b[C";
          break;
        case "C-c":
          translated = "\x03";
          break;
        case "C-d":
          translated = "\x04";
          break;
        default:
          // Regular character input
          translated = keys;
      }

      ptyManager.write(currentWorkspace.id, tabId, translated);
    },
    [currentWorkspace, selectedTabByWorkspace],
  );

  const handleCreateTab = useCallback(async () => {
    if (!currentWorkspace) return;
    const descriptor = descriptorMap[currentWorkspace.id];
    if (!descriptor) return;

    setMode("busy");
    try {
      const tabs = tabsByWorkspace[currentWorkspace.id] || [];
      const nextIndex = tabs.length + 1;
      const tabId = `tab-${nextIndex}`;
      const newTab: TabDescriptor = {
        id: tabId,
        label: `tab ${nextIndex}`,
      };

      const newTabs = [...tabs, newTab];
      setTabsByWorkspace((prev) => ({ ...prev, [currentWorkspace.id]: newTabs }));
      setSelectedTabByWorkspace((prev) => ({ ...prev, [currentWorkspace.id]: tabId }));
      setStatus(`Created tab ${newTab.label}`);

      // Create pty for new tab
      const ptyManager = ptyManagerRef.current;
      if (ptyManager) {
        ptyManager.createPty({
          workspaceId: currentWorkspace.id,
          tabId,
          label: newTab.label,
          path: descriptor.path,
        });
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setMode("ready");
    }
  }, [currentWorkspace, descriptorMap, tabsByWorkspace]);

  const startCreateWorkspace = useCallback(() => {
    setInputBuffer("");
    setStatus("Enter new branch or workspace name");
    setMode("creating-workspace");
  }, []);

  const cancelCreateWorkspace = useCallback(() => {
    setInputBuffer("");
    setStatus(null);
    setMode("ready");
  }, []);

  const submitCreateWorkspace = useCallback(async () => {
    const branch = inputBuffer.trim();
    if (!branch) {
      setStatus("Workspace name is required.");
      setMode("ready");
      return;
    }
    setMode("busy");
    try {
      const summary = await workspaceManager.createWorkspace({ branch });
      setStatus(`Created workspace ${branch}`);
      await refreshWorkspaces(summary.id);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setInputBuffer("");
      setMode("ready");
    }
  }, [inputBuffer, refreshWorkspaces, workspaceManager]);

  const toggleHelp = useCallback(() => {
    setShowHelp((prev) => !prev);
  }, []);

  const state: AppState = {
    mode,
    status,
    error,
    workspaces,
    descriptorMap,
    selectedWorkspaceId,
    tabsByWorkspace,
    selectedTabByWorkspace,
    inputBuffer,
    showHelp,
    terminalFocused,
    terminalOutput,
  };

  const actions: AppActions = {
    moveWorkspaceSelection,
    cycleTab,
    toggleTerminalFocus,
    handleCreateTab,
    startCreateWorkspace,
    cancelCreateWorkspace,
    submitCreateWorkspace,
    refreshWorkspaces,
    setInputBuffer,
    toggleHelp,
    sendKeysToTerminal,
  };

  const value: AppContextValue = {
    state,
    actions,
    currentWorkspace,
    currentTabs,
    selectedTabId,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
};
