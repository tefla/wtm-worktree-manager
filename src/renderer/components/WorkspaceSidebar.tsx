import React from "react";
import type { WorkspaceSummary } from "../types";
import { cx } from "../utils/cx";
import { buildStatusIcons, buildStatusTooltip } from "../utils/workspacePresentation";

interface WorkspaceSidebarProps {
  loading: boolean;
  workspaces: WorkspaceSummary[];
  activeWorkspacePath: string | null;
  onSelect: (workspace: WorkspaceSummary) => void;
  onRefreshWorkspace: (workspace: WorkspaceSummary) => void;
  onDeleteWorkspace: (workspace: WorkspaceSummary) => void;
  onUpdateWorkspace: (workspace: WorkspaceSummary) => void;
  updatingPaths: Record<string, boolean>;
}

export const WorkspaceSidebar: React.FC<WorkspaceSidebarProps> = ({
  loading,
  workspaces,
  activeWorkspacePath,
  onSelect,
  onRefreshWorkspace,
  onDeleteWorkspace,
  onUpdateWorkspace,
  updatingPaths,
}) => {
  return (
    <aside className="workspace-sidebar">
      <header className="workspace-sidebar-header">
        <h2>Workspaces</h2>
        <span>{loading ? "Loading…" : `${workspaces.length} found`}</span>
      </header>
      <div id="workspace-list" className="workspace-list">
        {loading ? (
          <div className="empty-state">Loading workspaces…</div>
        ) : workspaces.length === 0 ? (
          <div className="empty-state">No worktrees found. Create one to get started.</div>
        ) : (
          workspaces.map((workspace) => {
            const isSelected = workspace.path === activeWorkspacePath;
            const statusIcons = buildStatusIcons(workspace);
            const branchLabel = workspace.branch || workspace.relativePath || "Detached HEAD";
            const tooltip = buildStatusTooltip(workspace.status);
            const isUpdating = Boolean(updatingPaths[workspace.path]);
            return (
              <div
                key={workspace.path}
                className={cx("workspace-row", workspace.kind, { "is-active": isSelected })}
                data-path={workspace.path}
                title={tooltip}
                onClick={(event) => {
                  const target = event.target as HTMLElement;
                  if (target.closest("button")) {
                    return;
                  }
                  onSelect(workspace);
                }}
              >
                <div className="workspace-primary">
                  <span className="workspace-marker" />
                  <span className="workspace-name">{branchLabel}</span>
                </div>
                <div className="workspace-icons">
                  {statusIcons.map((icon, index) => {
                    if (icon.kind === "behind") {
                      return (
                        <button
                          key={`${icon.text}-${index}`}
                          type="button"
                          className={cx(icon.className, "status-icon-button")}
                          title={`${icon.tooltip}\nClick to pull the latest changes`}
                          onClick={(event) => {
                            event.stopPropagation();
                            onUpdateWorkspace(workspace);
                          }}
                          disabled={isUpdating}
                        >
                          {icon.text}
                        </button>
                      );
                    }
                    return (
                      <span key={`${icon.text}-${index}`} className={icon.className} title={icon.tooltip}>
                        {icon.text}
                      </span>
                    );
                  })}
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
                        onRefreshWorkspace(workspace);
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
                        onDeleteWorkspace(workspace);
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
  );
};
