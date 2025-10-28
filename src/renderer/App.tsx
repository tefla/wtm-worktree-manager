import React, { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  EnsureTerminalResponse,
  QuickAccessEntry,
  SettingsResponse,
  TerminalDataPayload,
  TerminalExitPayload,
  WorkspaceSummary,
} from "./types";

interface Toast {
  id: number;
  kind: "info" | "success" | "error";
  message: string;
}

interface TerminalEntry {
  sessionId: string | null;
  log: string;
  quickCommandExecuted: boolean;
  lastExitCode: number | null;
  lastSignal: string | null;
  label: string | null | undefined;
}

type WorkspaceTerminalMap = Record<string, Record<string, TerminalEntry>>;
type ActiveSlotMap = Record<string, string | null>;

type SessionIndexEntry = { workspacePath: string; slot: string };

function cx(
  ...values: Array<string | null | undefined | false | Record<string, boolean>>
): string {
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

function formatSummary(workspace: WorkspaceSummary): string {
  const status = workspace.status.summary;
  if (workspace.kind === "folder") {
    return status;
  }
  const parts: string[] = [status];
  if (!workspace.status.clean) {
    if (workspace.status.ahead > 0) {
      parts.push(`↑${workspace.status.ahead}`);
    }
    if (workspace.status.behind > 0) {
      parts.push(`↓${workspace.status.behind}`);
    }
  }
  if (workspace.status.upstream) {
    parts.push(`←→ ${workspace.status.upstream}`);
  }
  return parts.join(" · ");
}

function formatCommit(workspace: WorkspaceSummary): string {
  if (!workspace.lastCommit) {
    return "No commits yet";
  }
  const commit = workspace.lastCommit;
  return `${commit.shortSha} – ${commit.subject} (${commit.relativeTime} by ${commit.author})`;
}

function App(): JSX.Element {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(true);
  const [selectedWorkspacePath, setSelectedWorkspacePath] = useState<string | null>(null);
  const [environments, setEnvironments] = useState<SettingsResponse["environments"]>({});
  const [activeEnvironment, setActiveEnvironment] = useState<string>("");
  const [quickAccess, setQuickAccess] = useState<QuickAccessEntry[]>([]);
  const [branchInput, setBranchInput] = useState("");
  const [baseInput, setBaseInput] = useState("");
  const [createInFlight, setCreateInFlight] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastIdRef = useRef(0);

  const [workspaceTerminals, setWorkspaceTerminals] = useState<WorkspaceTerminalMap>({});
  const [activeSlots, setActiveSlots] = useState<ActiveSlotMap>({});
  const sessionIndex = useRef(new Map<string, SessionIndexEntry>());

  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.path === selectedWorkspacePath) ?? null,
    [workspaces, selectedWorkspacePath],
  );

  const activeSlot = selectedWorkspacePath ? activeSlots[selectedWorkspacePath] ?? null : null;

  const selectedTerminalEntries = selectedWorkspacePath
    ? workspaceTerminals[selectedWorkspacePath] ?? {}
    : {};

  const activeTerminalEntry = activeSlot ? selectedTerminalEntries[activeSlot] ?? null : null;

  const pushToast = useCallback((message: string, kind: Toast["kind"] = "info") => {
    toastIdRef.current += 1;
    const id = toastIdRef.current;
    setToasts((prev) => [...prev, { id, kind, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((toast) => toast.id !== id));
    }, kind === "error" ? 5600 : 4200);
  }, []);

  const loadWorkspaces = useCallback(async () => {
    setLoadingWorkspaces(true);
    try {
      const list = await window.workspaceAPI.list();
      setWorkspaces(list);
      if (list.length > 0 && !selectedWorkspacePath) {
        setSelectedWorkspacePath(list[0].path);
      }
    } catch (error) {
      console.error("Failed to load workspaces", error);
      pushToast("Failed to load workspaces", "error");
    } finally {
      setLoadingWorkspaces(false);
    }
  }, [pushToast, selectedWorkspacePath]);

  const loadSettings = useCallback(async () => {
    try {
      const response = await window.settingsAPI.listEnvironments();
      setEnvironments(response.environments);
      setActiveEnvironment(response.activeEnvironment);
      setQuickAccess(response.quickAccess);
    } catch (error) {
      console.error("Failed to load settings", error);
      pushToast("Failed to load settings", "error");
    }
  }, [pushToast]);

  useEffect(() => {
    void loadSettings();
    void loadWorkspaces();
  }, [loadSettings, loadWorkspaces]);

  useEffect(() => {
    const disposeData = window.terminalAPI.onData((payload: TerminalDataPayload) => {
      const meta = sessionIndex.current.get(payload.sessionId);
      if (!meta) {
        return;
      }
      setWorkspaceTerminals((prev) => {
        const workspaceEntry = prev[meta.workspacePath];
        if (!workspaceEntry) {
          return prev;
        }
        const terminal = workspaceEntry[meta.slot];
        if (!terminal) {
          return prev;
        }
        const updatedLog = (terminal.log + payload.data).slice(-40000);
        return {
          ...prev,
          [meta.workspacePath]: {
            ...workspaceEntry,
            [meta.slot]: {
              ...terminal,
              log: updatedLog,
            },
          },
        };
      });
    });

    const disposeExit = window.terminalAPI.onExit((payload: TerminalExitPayload) => {
      const meta = sessionIndex.current.get(payload.sessionId);
      if (!meta) {
        return;
      }
      sessionIndex.current.delete(payload.sessionId);
      setWorkspaceTerminals((prev) => {
        const workspaceEntry = prev[meta.workspacePath];
        if (!workspaceEntry) {
          return prev;
        }
        const terminal = workspaceEntry[meta.slot];
        if (!terminal) {
          return prev;
        }
        const exitLine = `\nProcess exited${
          payload.exitCode !== null ? ` with code ${payload.exitCode}` : ""
        }${payload.signal ? ` (signal ${payload.signal})` : ""}.`;
        return {
          ...prev,
          [meta.workspacePath]: {
            ...workspaceEntry,
            [meta.slot]: {
              ...terminal,
              lastExitCode: payload.exitCode,
              lastSignal: payload.signal,
              log: (terminal.log + exitLine).slice(-40000),
            },
          },
        };
      });
    });

    return () => {
      disposeData();
      disposeExit();
    };
  }, []);

  const hydrateWorkspaceTerminals = useCallback(async (workspacePath: string) => {
    if (workspaceTerminals[workspacePath]) {
      return;
    }
    try {
      const state = await window.terminalAPI.getWorkspaceState(workspacePath);
      setWorkspaceTerminals((prev) => ({
        ...prev,
        [workspacePath]: Object.fromEntries(
          Object.entries(state.terminals || {}).map(([slot, info]) => [
            slot,
            {
              sessionId: null,
              log: info.history || "",
              quickCommandExecuted: info.quickCommandExecuted,
              lastExitCode: info.lastExitCode,
              lastSignal: info.lastSignal,
              label: info.label,
            },
          ]),
        ),
      }));
      setActiveSlots((prev) => ({
        ...prev,
        [workspacePath]: state.activeTerminal ?? Object.keys(state.terminals || {})[0] ?? null,
      }));
    } catch (error) {
      console.error("Failed to load workspace terminals", error);
    }
  }, [workspaceTerminals]);

  const handleSelectWorkspace = useCallback(
    async (workspace: WorkspaceSummary) => {
      setSelectedWorkspacePath(workspace.path);
      await hydrateWorkspaceTerminals(workspace.path);
    },
    [hydrateWorkspaceTerminals],
  );

  useEffect(() => {
    if (selectedWorkspace) {
      void hydrateWorkspaceTerminals(selectedWorkspace.path);
    }
  }, [hydrateWorkspaceTerminals, selectedWorkspace]);

  const ensureWorkspaceSelected = useCallback(() => {
    if (!selectedWorkspace) {
      pushToast("Select a workspace first", "info");
      return false;
    }
    return true;
  }, [pushToast, selectedWorkspace]);

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
        const workspace = await window.workspaceAPI.create({ branch, baseRef: baseRef || undefined });
        pushToast(`Workspace '${workspace.branch ?? workspace.relativePath}' ready`, "success");
        setBranchInput("");
        setBaseInput("");
        await loadWorkspaces();
        setSelectedWorkspacePath(workspace.path);
      } catch (error) {
        console.error("Failed to create workspace", error);
        pushToast("Failed to create workspace", "error");
      } finally {
        setCreateInFlight(false);
      }
    },
    [baseInput, branchInput, loadWorkspaces, pushToast],
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

  const handleRefreshWorkspace = useCallback(async () => {
    if (!ensureWorkspaceSelected() || !selectedWorkspace) {
      return;
    }
    try {
      const refreshed = await window.workspaceAPI.refresh({ path: selectedWorkspace.path });
      setWorkspaces((prev) =>
        prev.map((workspace) => (workspace.path === refreshed.path ? refreshed : workspace)),
      );
      pushToast("Workspace refreshed", "success");
    } catch (error) {
      console.error("Failed to refresh workspace", error);
      pushToast("Failed to refresh workspace", "error");
    }
  }, [ensureWorkspaceSelected, pushToast, selectedWorkspace]);

  const handleDeleteWorkspace = useCallback(async () => {
    if (!ensureWorkspaceSelected() || !selectedWorkspace) {
      return;
    }
    const confirmed = window.confirm(
      `Delete workspace '${selectedWorkspace.branch ?? selectedWorkspace.relativePath}'?`,
    );
    if (!confirmed) {
      return;
    }
    try {
      const result = await window.workspaceAPI.delete({ path: selectedWorkspace.path });
      if (!result.success) {
        pushToast(result.message ?? "Failed to delete workspace", "error");
        return;
      }
      pushToast("Workspace deleted", "success");
      sessionIndex.current.forEach((value, key) => {
        if (value.workspacePath === selectedWorkspace.path) {
          sessionIndex.current.delete(key);
        }
      });
      setWorkspaceTerminals((prev) => {
        const clone = { ...prev };
        delete clone[selectedWorkspace.path];
        return clone;
      });
      setActiveSlots((prev) => {
        const clone = { ...prev };
        delete clone[selectedWorkspace.path];
        return clone;
      });
      setSelectedWorkspacePath(null);
      await loadWorkspaces();
    } catch (error) {
      console.error("Failed to delete workspace", error);
      pushToast("Failed to delete workspace", "error");
    }
  }, [ensureWorkspaceSelected, loadWorkspaces, pushToast, selectedWorkspace]);

  const handleEnvironmentChange = useCallback(
    async (name: string) => {
      setActiveEnvironment(name);
      try {
        const response = await window.settingsAPI.setActiveEnvironment({ name });
        setEnvironments(response.environments);
        setActiveEnvironment(response.activeEnvironment);
        setQuickAccess(response.quickAccess);
        sessionIndex.current.clear();
        setWorkspaceTerminals({});
        setActiveSlots({});
        setSelectedWorkspacePath(null);
        pushToast(`Environment switched to ${name}`, "success");
        await loadWorkspaces();
      } catch (error) {
        console.error("Failed to switch environment", error);
        pushToast("Failed to switch environment", "error");
      }
    },
    [loadWorkspaces, pushToast],
  );

  const registerSession = useCallback((result: EnsureTerminalResponse) => {
    sessionIndex.current.set(result.sessionId, { workspacePath: result.workspacePath, slot: result.slot });
  }, []);

  const handleRunQuickCommand = useCallback(
    async (entry: QuickAccessEntry) => {
      if (!ensureWorkspaceSelected() || !selectedWorkspace) {
        return;
      }
      try {
        const result = await window.terminalAPI.ensureSession({
          workspacePath: selectedWorkspace.path,
          slot: entry.key,
          label: entry.label,
        });
        registerSession(result);
        setWorkspaceTerminals((prev) => {
          const workspaceEntry = prev[selectedWorkspace.path] ?? {};
          return {
            ...prev,
            [selectedWorkspace.path]: {
              ...workspaceEntry,
              [entry.key]: {
                sessionId: result.sessionId,
                log: result.history || "",
                quickCommandExecuted: result.quickCommandExecuted,
                lastExitCode: result.lastExitCode,
                lastSignal: result.lastSignal,
                label: entry.label,
              },
            },
          };
        });
        setActiveSlots((prev) => ({ ...prev, [selectedWorkspace.path]: entry.key }));
        void window.terminalAPI.setActiveTerminal(selectedWorkspace.path, entry.key);
        const commandText = `${entry.quickCommand.trim()}\r`;
        window.terminalAPI.write(result.sessionId, commandText);
        await window.terminalAPI.markQuickCommand(selectedWorkspace.path, entry.key);
        setWorkspaceTerminals((prev) => {
          const workspaceEntry = prev[selectedWorkspace.path] ?? {};
          const terminal = workspaceEntry[entry.key];
          if (!terminal) {
            return prev;
          }
          return {
            ...prev,
            [selectedWorkspace.path]: {
              ...workspaceEntry,
              [entry.key]: {
                ...terminal,
                quickCommandExecuted: true,
                log: (terminal.log + `\n$ ${entry.quickCommand}\n`).slice(-40000),
              },
            },
          };
        });
        pushToast(`Quick command '${entry.label}' sent`, "success");
      } catch (error) {
        console.error("Failed to run quick command", error);
        pushToast("Failed to run quick command", "error");
      }
    },
    [ensureWorkspaceSelected, pushToast, registerSession, selectedWorkspace],
  );

  const handleSelectSlot = useCallback(
    (slot: string) => {
      if (!selectedWorkspace) return;
      setActiveSlots((prev) => ({ ...prev, [selectedWorkspace.path]: slot }));
      void window.terminalAPI.setActiveTerminal(selectedWorkspace.path, slot);
    },
    [selectedWorkspace],
  );

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
          Workspaces are created under the path configured in your settings file. New branches fall back to
          <code> origin/develop </code> when no remote exists.
        </p>
      </section>

      <main className="workspace-area">
        <aside className="workspace-sidebar">
          <header className="workspace-sidebar-header">
            <span>Workspaces</span>
          </header>
          <div id="workspace-list" className="workspace-list" aria-live="polite">
            {loadingWorkspaces ? (
              <div className="workspace-list-empty">Loading workspaces…</div>
            ) : workspaces.length === 0 ? (
              <div className="workspace-list-empty">No workspaces yet</div>
            ) : (
              workspaces.map((workspace) => {
                const isSelected = workspace.path === selectedWorkspacePath;
                return (
                  <button
                    key={workspace.path}
                    type="button"
                    className={cx("workspace-list-item", { selected: isSelected })}
                    onClick={() => handleSelectWorkspace(workspace)}
                  >
                    <span className="workspace-item-name">{workspace.branch ?? workspace.relativePath}</span>
                    <span className="workspace-item-meta">{formatSummary(workspace)}</span>
                  </button>
                );
              })
            )}
          </div>
        </aside>
        <section id="workspace-detail" className="workspace-detail">
          {!selectedWorkspace ? (
            <div id="workspace-detail-placeholder" className="detail-placeholder">
              <h2>Workspace Details</h2>
              <p>Select a workspace from the list to see more information.</p>
            </div>
          ) : (
            <div className="workspace-detail-content">
              <header className="workspace-detail-header">
                <div>
                  <h2>{selectedWorkspace.branch ?? selectedWorkspace.relativePath}</h2>
                  <p className="workspace-path">{selectedWorkspace.path}</p>
                </div>
                <div className="workspace-detail-actions">
                  <button className="ghost-button" type="button" onClick={handleRefreshWorkspace}>
                    Refresh
                  </button>
                  <button className="danger-button" type="button" onClick={handleDeleteWorkspace}>
                    Delete
                  </button>
                </div>
              </header>

              <section className="workspace-summary">
                <h3>Status</h3>
                <p>{formatSummary(selectedWorkspace)}</p>
                <h3>Last commit</h3>
                <p>{formatCommit(selectedWorkspace)}</p>
                {selectedWorkspace.status.sampleChanges.length > 0 && (
                  <div className="workspace-changes">
                    <h4>Recent changes</h4>
                    <ul>
                      {selectedWorkspace.status.sampleChanges.map((change) => (
                        <li key={change}>{change}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </section>

              <section className="workspace-terminals">
                <header>
                  <h3>Quick commands</h3>
                </header>
                {quickAccess.length === 0 ? (
                  <p className="workspace-terminals-empty">No quick commands configured.</p>
                ) : (
                  <ul className="quick-command-list">
                    {quickAccess.map((entry) => {
                      const terminalEntry = selectedTerminalEntries[entry.key];
                      const isActive = activeSlot === entry.key;
                      return (
                        <li key={entry.key} className={cx({ active: isActive })}>
                          <div className="quick-command-row">
                            <div className="quick-command-details">
                              <strong>{entry.label}</strong>
                              <span className="quick-command-meta">{entry.quickCommand}</span>
                            </div>
                            <div className="quick-command-actions">
                              <button
                                type="button"
                                className="primary-button"
                                onClick={() => handleRunQuickCommand(entry)}
                              >
                                Run
                              </button>
                              <button
                                type="button"
                                className="ghost-button"
                                onClick={() => handleSelectSlot(entry.key)}
                              >
                                View log
                              </button>
                            </div>
                          </div>
                          {terminalEntry && (
                            <div className="quick-command-status">
                              {terminalEntry.quickCommandExecuted ? "Executed" : "Pending"}
                              {terminalEntry.lastExitCode !== null && (
                                <span className="quick-command-exit"> · Exit {terminalEntry.lastExitCode}</span>
                              )}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}

                {activeTerminalEntry ? (
                  <div className="terminal-log" role="log">
                    <pre>{activeTerminalEntry.log || "No output yet."}</pre>
                  </div>
                ) : (
                  <div className="terminal-log terminal-log-empty">
                    <p>Select a quick command to view its output.</p>
                  </div>
                )}
              </section>
            </div>
          )}
        </section>
      </main>

      <div id="toast-container" className="toast-container">
        {toasts.map((toast) => (
          <div key={toast.id} className={cx("toast", toast.kind)}>
            {toast.message}
          </div>
        ))}
      </div>
    </div>
  );
}

export default App;
