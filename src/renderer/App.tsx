import React, { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppHeader } from "./components/AppHeader";
import { WorkspaceSidebar } from "./components/WorkspaceSidebar";
import { WorkspaceTabsPanel } from "./components/WorkspaceTabsPanel";
import { ComposeServicesPanel } from "./components/ComposeServicesPanel";
import type { BranchSuggestion } from "./components/CreateWorkspaceForm";
import type { TerminalDefinition } from "./stateTypes";
import { cx } from "./utils/cx";
import type { ProjectState, QuickAccessEntry, WorkspaceSummary } from "./types";
import { useWorkspaces } from "./hooks/useWorkspaces";
import { buildWorkspaceBranchName } from "../shared/jira";
import type { JiraTicketSummary } from "../shared/jira";
import type { DockerComposeServiceInfo } from "../shared/dockerCompose";

type ToastKind = "info" | "success" | "error";

interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}


interface RecentProject {
  path: string;
  name: string;
}

const RECENT_PROJECTS_STORAGE_KEY = "wtm:recent-projects";
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
  const [refreshing, setRefreshing] = useState(false);
  const [branchInput, setBranchInput] = useState("");
  const [baseInput, setBaseInput] = useState("");
  const autoBaseRefRef = useRef<string | null>(null);
  const [createInFlight, setCreateInFlight] = useState(false);
  const [jiraTickets, setJiraTickets] = useState<JiraTicketSummary[]>([]);
  const [branchCatalog, setBranchCatalog] = useState<{ local: string[]; remote: string[] }>({ local: [], remote: [] });
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);
  const [activeProjectPath, setActiveProjectPath] = useState<string | null>(null);
  const [activeProjectName, setActiveProjectName] = useState<string>("");
  const [composeProjectName, setComposeProjectName] = useState<string | null>(null);
  const [composeServices, setComposeServices] = useState<DockerComposeServiceInfo[]>([]);
  const [composeError, setComposeError] = useState<string | null>(null);
  const [composeLoading, setComposeLoading] = useState(false);
  const [openProjectsInNewWindow, setOpenProjectsInNewWindow] = useState(false);
  const defaultTerminalsRef = useRef<TerminalDefinition[]>([]);
  const [toastList, setToastList] = useState<Toast[]>([]);
  const toastIdRef = useRef(0);

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

  const refreshComposeServices = useCallback(async () => {
    if (!activeProjectPath) {
      setComposeServices([]);
      setComposeProjectName(null);
      setComposeError(null);
      setComposeLoading(false);
      return;
    }
    setComposeLoading(true);
    try {
      const snapshot = await window.projectAPI.listComposeServices();
      setComposeServices(normaliseComposeServices(snapshot?.services));
      const projectLabel =
        typeof snapshot?.projectName === "string" && snapshot.projectName.trim()
          ? snapshot.projectName
          : activeProjectName || null;
      setComposeProjectName(projectLabel);
      setComposeError(typeof snapshot?.error === "string" && snapshot.error ? snapshot.error : null);
    } catch (error) {
      console.error("Failed to load docker compose services", error);
      setComposeError("Failed to load docker compose services");
    } finally {
      setComposeLoading(false);
    }
  }, [activeProjectName, activeProjectPath]);

  const loadBranches = useCallback(async () => {
    if (!activeProjectPath || !window.workspaceAPI?.listBranches) {
      setBranchCatalog({ local: [], remote: [] });
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
      setBranchCatalog({
        local: normalizeList(payload.local),
        remote: normalizeList(payload.remote),
      });
    } catch (error) {
      console.warn("Failed to load branch catalog", error);
      setBranchCatalog({ local: [], remote: [] });
    }
  }, [activeProjectPath]);

  const loadJiraTickets = useCallback(async (options: { forceRefresh?: boolean } = {}) => {
    if (!window.jiraAPI?.listTickets) {
      setJiraTickets([]);
      return;
    }
    try {
      const response = await window.jiraAPI.listTickets(options);
      if (!Array.isArray(response)) {
        setJiraTickets([]);
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
      setJiraTickets(normalized);
    } catch (error) {
      console.warn("Failed to load Jira ticket cache", error);
    }
  }, []);

  const {
    workspaces,
    loadingWorkspaces,
    workspaceOrder,
    workspaceTabs,
    activeWorkspacePath,
    updatingWorkspaces,
    handleWorkspaceSelect,
    handleWorkspaceTabSelect,
    handleAddTerminal,
    handleTerminalTabClick,
    handleTerminalClose,
    handleTerminalStart,
    handleTerminalDispose,
    handleRefreshWorkspace,
    handleUpdateWorkspace,
    handleDeleteWorkspace,
    loadWorkspaces,
  } = useWorkspaces({
    activeProjectPath,
    defaultTerminalsRef,
    pushToast,
    normaliseQuickAccessList,
  });

  const applyProjectState = useCallback(
    (state: ProjectState, options: { persistRecent?: boolean } = {}) => {
      const { persistRecent = true } = options;
      const normalizedQuickAccess = normaliseQuickAccessList(state.quickAccess, { fallbackToDefault: true });
      defaultTerminalsRef.current = normalizedQuickAccess;
      setActiveProjectName(state.projectName);
      setComposeProjectName(state.composeProjectName ?? null);
      setComposeServices(normaliseComposeServices(state.composeServices));
      setComposeError(state.composeError ?? null);
      setComposeLoading(false);
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
        autoBaseRefRef.current = null;
        await loadWorkspaces();
        await loadBranches();
        await handleWorkspaceSelect(workspace);
      } catch (error) {
        console.error("Failed to create workspace", error);
        pushToast("Failed to create workspace", "error");
      } finally {
        setCreateInFlight(false);
      }
    },
    [activeProjectPath, baseInput, branchInput, handleWorkspaceSelect, loadBranches, loadWorkspaces, pushToast],
  );

  const handleRefreshAll = useCallback(async () => {
    setRefreshing(true);
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
      setRefreshing(false);
    }
  }, [activeProjectPath, loadBranches, loadJiraTickets, loadWorkspaces, pushToast, refreshComposeServices]);

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
  }, [applyProjectState, openProjectByPath]);

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
      setBranchCatalog({ local: [], remote: [] });
      setJiraTickets([]);
      setComposeServices([]);
      setComposeProjectName(null);
      setComposeError(null);
      setComposeLoading(false);
      return;
    }
    void loadBranches();
    void loadJiraTickets();
  }, [activeProjectPath, loadBranches, loadJiraTickets]);

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
      setBranchInput(value);
      if (!value) {
        if (autoBaseRefRef.current) {
          setBaseInput((current) => (current === autoBaseRefRef.current ? "" : current));
          autoBaseRefRef.current = null;
        }
        return;
      }
      const match = branchSuggestions.find((suggestion) => suggestion.value === value);
      if (match?.baseRef) {
        autoBaseRefRef.current = match.baseRef;
        setBaseInput(match.baseRef);
      } else if (autoBaseRefRef.current) {
        setBaseInput((current) => (current === autoBaseRefRef.current ? "" : current));
        autoBaseRefRef.current = null;
      }
    },
    [branchSuggestions],
  );

  const handleBaseChange = useCallback((value: string) => {
    autoBaseRefRef.current = null;
    setBaseInput(value);
  }, []);

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
          workspaceTabs={workspaceTabs}
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
