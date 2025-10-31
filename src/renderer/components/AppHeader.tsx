import React, { useEffect, useMemo, useRef, useState } from "react";
import { CreateWorkspaceForm, CreateWorkspaceFormProps } from "./CreateWorkspaceForm";

interface AppHeaderProps {
  title: string;
  subtitle: string;
  recentProjects: Array<{ path: string; label: string; icon: string | null }>;
  activeProjectPath: string | null;
  refreshing: boolean;
  onSelectProject: (path: string) => void;
  onRemoveProject: (path: string) => void;
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
  onRemoveProject,
  onOpenProject,
  onRefreshAll,
  createWorkspace,
  openProjectsInNewWindow,
  onToggleNewWindow,
  onOpenSettings,
  settingsDisabled,
}) => {
  const hasProjects = recentProjects.length > 0;
  const [menuOpen, setMenuOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const activeProject = useMemo(
    () => recentProjects.find((project) => project.path === activeProjectPath) ?? null,
    [recentProjects, activeProjectPath],
  );

  const triggerLabel = activeProjectPath
    ? activeProject?.label ?? activeProjectPath
    : "Select a project";
  const triggerIcon = activeProject?.icon ?? null;

  const closeMenu = () => setMenuOpen(false);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    const handleDocumentClick = (event: MouseEvent) => {
      const menuEl = menuRef.current;
      const triggerEl = triggerRef.current;
      if (!menuEl || !triggerEl) {
        return;
      }
      if (
        !menuEl.contains(event.target as Node) &&
        !triggerEl.contains(event.target as Node)
      ) {
        setMenuOpen(false);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleDocumentClick);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleDocumentClick);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!recentProjects.length) {
      setMenuOpen(false);
    }
  }, [recentProjects.length]);

  const handleToggleMenu = () => {
    if (!hasProjects) {
      return;
    }
    setMenuOpen((value) => !value);
  };

  const handleSelectProject = (path: string) => {
    closeMenu();
    onSelectProject(path);
  };

  const handleRemoveProject = (path: string) => {
    onRemoveProject(path);
  };

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
            <div
              className={`project-dropdown${menuOpen ? " is-open" : ""}${!hasProjects ? " is-disabled" : ""}`}
            >
              <button
                ref={triggerRef}
                id="project-select"
                type="button"
                className="project-dropdown__trigger"
                onClick={handleToggleMenu}
                disabled={!hasProjects}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
              >
                <span className="project-dropdown__value">
                  {triggerIcon ? <span className="project-dropdown__icon" aria-hidden="true">{triggerIcon}</span> : null}
                  <span className="project-dropdown__label">{triggerLabel}</span>
                </span>
                <span className="project-dropdown__caret" aria-hidden="true" />
              </button>
              {menuOpen ? (
                <div
                  ref={menuRef}
                  role="menu"
                  aria-labelledby="project-select"
                  className="project-dropdown__menu"
                >
                  {recentProjects.map((project) => {
                    const isActive = project.path === activeProjectPath;
                    return (
                      <div
                        key={project.path}
                        className={`project-dropdown__item${isActive ? " is-active" : ""}`}
                      >
                        <button
                          type="button"
                          className="project-dropdown__select"
                          onClick={() => handleSelectProject(project.path)}
                          role="menuitem"
                        >
                          {project.icon ? (
                            <span className="project-dropdown__icon" aria-hidden="true">
                              {project.icon}
                            </span>
                          ) : null}
                          <span className="project-dropdown__label">{project.label}</span>
                        </button>
                        <button
                          type="button"
                          className="project-dropdown__remove"
                          onClick={(event) => {
                            event.stopPropagation();
                            event.preventDefault();
                            handleRemoveProject(project.path);
                          }}
                          aria-label={`Remove ${project.label} from recent projects`}
                        >
                          <span className="project-dropdown__remove-icon" aria-hidden="true" />
                        </button>
                      </div>
                    );
                  })}
                  {!recentProjects.length ? (
                    <div className="project-dropdown__empty">No recent projects</div>
                  ) : null}
                </div>
              ) : null}
            </div>
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
