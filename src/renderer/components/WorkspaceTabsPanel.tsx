import React, { useEffect, useRef } from "react";
import type { WorkspaceSummary } from "../types";
import type { TerminalRecord, WorkspaceTabState } from "../stateTypes";
import { cx } from "../utils/cx";
import { buildWorkspaceDetailTooltip } from "../utils/workspacePresentation";

interface WorkspaceTabsPanelProps {
  workspaceOrder: string[];
  workspaceTabs: Map<string, WorkspaceTabState>;
  activeWorkspacePath: string | null;
  onSelectWorkspace: (workspacePath: string) => void;
  onRefreshWorkspace: (workspace: WorkspaceSummary) => void;
  onDeleteWorkspace: (workspace: WorkspaceSummary) => void;
  onAddTerminal: (workspacePath: string) => void;
  onTerminalTabClick: (workspacePath: string, terminalKey: string) => void;
  onTerminalClose: (workspacePath: string, terminalKey: string) => void;
  onTerminalStart: (workspacePath: string, record: TerminalRecord, container: HTMLDivElement) => void;
  onTerminalDispose: (workspacePath: string, record: TerminalRecord) => void;
}

const TerminalPlaceholder: React.FC = () => (
  <div className="terminal-placeholder">Select a quick action or use the + button to start a terminal.</div>
);

interface TerminalPanelProps {
  workspacePath: string;
  record: TerminalRecord;
  isActive: boolean;
  onStart: WorkspaceTabsPanelProps["onTerminalStart"];
  onDispose: WorkspaceTabsPanelProps["onTerminalDispose"];
}

const TerminalPanel: React.FC<TerminalPanelProps> = ({ workspacePath, record, isActive, onStart, onDispose }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    if (record.shouldStart || record.sessionId) {
      onStart(workspacePath, record, container);
    }
  }, [record, workspacePath, onStart, record.shouldStart, record.sessionId]);

  useEffect(
    () => () => {
      onDispose(workspacePath, record);
    },
    [workspacePath, record, onDispose],
  );

  return (
    <div className={cx("terminal-panel", { "is-active": isActive })} data-key={record.key}>
      <div ref={containerRef} className="terminal-view" />
    </div>
  );
};

export const WorkspaceTabsPanel: React.FC<WorkspaceTabsPanelProps> = ({
  workspaceOrder,
  workspaceTabs,
  activeWorkspacePath,
  onSelectWorkspace,
  onRefreshWorkspace,
  onDeleteWorkspace,
  onAddTerminal,
  onTerminalTabClick,
  onTerminalClose,
  onTerminalStart,
  onTerminalDispose,
}) => {
  const activeWorkspaceState = activeWorkspacePath ? workspaceTabs.get(activeWorkspacePath) ?? null : null;

  return (
    <section id="workspace-tabs" className={cx("workspace-detail", { "is-empty": !activeWorkspaceState })}>
      <div className="workspace-tab-bar">
        {workspaceOrder.map((path) => {
          const state = workspaceTabs.get(path);
          if (!state) {
            return null;
          }
          const label = state.workspace.branch || state.workspace.relativePath || state.workspace.path;
          return (
            <button
              key={path}
              type="button"
              className={cx("workspace-tab", { "is-active": activeWorkspacePath === path })}
              onClick={() => onSelectWorkspace(path)}
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
            const state = workspaceTabs.get(path);
            if (!state) return null;
            const isActive = path === activeWorkspacePath;
            const workspace = state.workspace;
            return (
              <div key={path} className={cx("workspace-panel", { "is-active": isActive })} data-path={workspace.path}>
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
                    <button className="ghost-button" type="button" onClick={() => void onRefreshWorkspace(workspace)}>
                      Refresh
                    </button>
                    <button className="danger-button" type="button" onClick={() => void onDeleteWorkspace(workspace)}>
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
                          onClick={() => onTerminalTabClick(state.workspace.path, key)}
                        >
                          {record.label}
                        </button>
                        <button
                          type="button"
                          className="terminal-tab-close"
                          aria-label={`Close ${record.label}`}
                          onClick={() => onTerminalClose(state.workspace.path, key)}
                        >
                          ×
                        </button>
                      </div>
                    );
                  })}
                  <button
                    type="button"
                    className="terminal-tab-add"
                    onClick={() => onAddTerminal(state.workspace.path)}
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
                            onStart={onTerminalStart}
                            onDispose={onTerminalDispose}
                          />
                        );
                      })
                    : <TerminalPlaceholder />}
                </div>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
};
