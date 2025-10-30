import React from "react";
import { CreateWorkspaceForm, CreateWorkspaceFormProps } from "./CreateWorkspaceForm";

interface AppHeaderProps {
  title: string;
  subtitle: string;
  recentProjects: Array<{ path: string; label: string; icon: string | null }>;
  activeProjectPath: string | null;
  refreshing: boolean;
  onSelectProject: (path: string) => void;
  onOpenProject: () => void;
  onRefreshAll: () => void;
  createWorkspace: Omit<CreateWorkspaceFormProps, "variant">;
  openProjectsInNewWindow: boolean;
  onToggleNewWindow: (value: boolean) => void;
  onOpenSettings: () => void;
  settingsDisabled: boolean;
}

export const AppHeader: React.FC<AppHeaderProps> = ({
  title,
  subtitle,
  recentProjects,
  activeProjectPath,
  refreshing,
  onSelectProject,
  onOpenProject,
  onRefreshAll,
  createWorkspace,
  openProjectsInNewWindow,
  onToggleNewWindow,
  onOpenSettings,
  settingsDisabled,
}) => {
  const hasProjects = recentProjects.length > 0;
  const selectValue = activeProjectPath ?? "";
  const showPlaceholder = !selectValue;

  return (
    <header className="app-header">
      <div className="header-row">
        <div className="header-text">
          <h1>{title}</h1>
          <p>{subtitle}</p>
        </div>
        <div className="header-actions">
          <label className="environment-switcher">
            <span>Project</span>
            <select
              id="project-select"
              name="project"
              value={selectValue}
              onChange={(event) => onSelectProject(event.target.value)}
              disabled={!hasProjects}
            >
              {showPlaceholder && (
                <option value="" disabled>
                  Select a project
                </option>
              )}
              {recentProjects.map((project) => {
                const optionLabel = project.icon ? `${project.icon} ${project.label}` : project.label;
                return (
                  <option key={project.path} value={project.path} data-icon={project.icon ?? undefined}>
                    {optionLabel}
                  </option>
                );
              })}
            </select>
          </label>
          <label className="header-toggle" htmlFor="project-open-new-window">
            <input
              id="project-open-new-window"
              type="checkbox"
              checked={openProjectsInNewWindow}
              onChange={(event) => onToggleNewWindow(event.target.checked)}
            />
            <span>Open in new window</span>
          </label>
          <button className="ghost-button" type="button" onClick={onOpenProject}>
            Open…
          </button>
          <button className="ghost-button" type="button" onClick={onOpenSettings} disabled={settingsDisabled}>
            Settings
          </button>
          <button
            id="refresh-button"
            className="accent-button"
            type="button"
            onClick={onRefreshAll}
            disabled={refreshing}
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>
      <CreateWorkspaceForm {...createWorkspace} variant="inline" />
    </header>
  );
};
